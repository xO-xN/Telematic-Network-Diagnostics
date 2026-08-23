// Socket.IO performer protocol: join, claim-token identity, reconnect
// restore, control forwarding, seat persistence and state broadcast.
//
// Reusable PNDS core: every work built on the template speaks this
// protocol with its performer and monitor pages. The module owns two
// memory rules —
//   - reconnect restore: voice state is persisted per claim token in the
//     shape projectAudio.voiceState() returns (raw fader values, never
//     mapped ones) and handed to projectAudio.addVoice() so a reconnect
//     births the voice already restored; a voice that still exists is
//     re-fed through projectAudio.restoreVoice(). In-memory: it must
//     survive phone locks, not server restarts.
//   - seat persistence: id + output channel per claim token live in the
//     SeatsStore (disk), so a restarted work hands every known device
//     back its seat and channel. The monitor's reset-ids wipes both.
//
// Work-specific semantics stay in audio/controller.js — including the
// shape of a control payload: this module forwards it opaquely and the
// work layer validates and clamps every field it reads. Event names
// come from public/shared.js via the caller, so each work keeps its own
// wire vocabulary.

function attachProtocol(io, { events, registry, projectAudio, seats }) {
  // Last known voice state per claim token, restored when the client
  // reconnects. (Ids are reused after a disconnect; the token is the
  // persistent identity.)
  const lastControls = new Map();

  // Persist the voice's current state under the token that owns it:
  // the in-memory fader state (reconnect restore) and the disk seat
  // record {id, out} (restart restore). The token is resolved by voice
  // id, never from the sender's socket: the set-out sender is often the
  // operator, who never joins and would otherwise persist nothing. Call
  // while the assignment and the voice both still exist.
  function persist(id) {
    const token = registry.getTokenById(id);

    if (token === null) {
      return;
    }

    const state = projectAudio.voiceState(id);

    if (state) {
      lastControls.set(token, state);
      seats.record(token, { id, out: state.out });
    }
  }

  function broadcastState() {
    io.emit(events.state, {
      clients: projectAudio.snapshot(),
    });
  }

  io.on("connection", (socket) => {
    socket.on(events.join, async (payload) => {
      // A seat recorded for this token in a previous run of the work:
      // reclaim its id (reserved against other devices), and fall back
      // to its channel when no fresher in-memory state exists.
      const seat = seats.get(payload && payload.token);

      const result = registry.allocate({
        socketId: socket.id,
        claimToken: payload && payload.token,
        preferredId: seat ? seat.id : null,
        reservedIds: seats.reservedIds(seat ? seat.id : null),
      });

      if (result.status === "rejected") {
        console.log(`[protocol] join rejected: ${result.message}`);
        socket.emit(events.rejected, {
          reason: result.message,
        });
        socket.disconnect(true);
        return;
      }

      try {
        // State recovery is keyed by the persistent claim token, not the
        // id: ids are reused after a disconnect, the token is the identity.
        const last = lastControls.get(result.token);

        // After a restart there is no in-memory state; the recorded seat
        // still carries the channel.
        const birthState = last || (seat ? { out: seat.out } : null);

        if (!projectAudio.hasVoice(result.id)) {
          // Birth the voice with its persisted state when there is one:
          // creating it with defaults and restoring afterwards passes
          // through audible intermediate states (the restored amp
          // sounding on the default channel). Phones locking mid-show
          // make reconnects a regular event, not an edge case.
          await projectAudio.addVoice(result.id, birthState);
        } else if (last) {
          // Takeover reconnect that raced the old socket's disconnect —
          // the voice is still alive, re-feed it in place.
          await projectAudio.restoreVoice(result.id, last);
        }

        // Record the seat from the voice's actual state (heals a stale
        // channel the current engine can't route).
        persist(result.id);

        console.log(
          `[protocol] join: client ${result.id} (${result.status})`,
        );

        socket.emit(events.joined, {
          id: result.id,
          token: result.token,
          recovered: Boolean(last),
        });

        broadcastState();
      } catch (error) {
        console.error(
          `[protocol] failed to create voice for client ${result.id}:`,
          error,
        );
        registry.release(result.id);
        socket.emit(events.rejected, {
          reason: "Audio voice could not be created.",
        });
        socket.disconnect(true);
      }
    });

    socket.on(events.control, async (payload) => {
      const id = registry.findIdBySocket(socket.id);

      if (id === null) {
        return;
      }

      try {
        // The payload is opaque at this seam — its shape is the work
        // layer's vocabulary; projectAudio validates and clamps every
        // field it reads.
        await projectAudio.setControls(id, payload);

        persist(id);
        broadcastState();
      } catch (error) {
        console.error(`[protocol] control failed for client ${id}:`, error);
      }
    });

    socket.on(events.setOut, async (payload) => {
      // Two senders: a performer page reassigns its own voice (no id);
      // the monitor page never joins and names the target client instead.
      const id =
        payload && payload.id !== undefined
          ? Number(payload.id)
          : registry.findIdBySocket(socket.id);

      if (
        !Number.isInteger(id) ||
        id < 1 ||
        !payload ||
        payload.out === undefined
      ) {
        return;
      }

      try {
        await projectAudio.setOutChannel(id, payload.out);

        persist(id);
        broadcastState();
      } catch (error) {
        console.error(`[protocol] set-out failed for client ${id}:`, error);
      }
    });

    // The monitor's seat move: reassign a device to another seat number.
    // The assignment, the voice (reborn from its current state — the
    // born-restored path, no audible intermediate) and the seat record
    // all move together, and the device's page learns its new id through
    // the same joined event a join produces. The target must be free of
    // LIVE devices; a stale seat record at the target is evicted.
    socket.on(events.setSeat, async (payload) => {
      const id = payload ? Number(payload.id) : NaN;
      const to = payload ? Number(payload.to) : NaN;

      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(to)) {
        return;
      }

      const state = projectAudio.voiceState(id);

      if (!state || !registry.reassign(id, to)) {
        return; // no such voice, or the target seat is live
      }

      try {
        await projectAudio.removeVoice(id);
        await projectAudio.addVoice(to, state);

        // Records the moved seat under the token (evicting any stale
        // record at the target id) and refreshes the in-memory state.
        persist(to);

        const entry = registry.list().find((candidate) => candidate.id === to);
        const performer = entry && io.sockets.sockets.get(entry.socketId);

        if (performer) {
          // The page's id tracking keys off joined; re-issuing it with
          // the new id retargets myId/myOut with zero page changes.
          performer.emit(events.joined, {
            id: to,
            token: registry.getTokenById(to),
            recovered: false,
          });
        }

        broadcastState();
      } catch (error) {
        console.error(`[protocol] seat move ${id} -> ${to} failed:`, error);

        // Best-effort rollback: give the assignment back and re-birth
        // the voice at the old seat, so the device is not left silent.
        registry.reassign(to, id);

        await projectAudio.addVoice(id, state).catch(() => {});
      }
    });

    // The monitor's reset button: wipe every recorded seat and live
    // assignment, then bounce the performer sockets. Each page
    // auto-reconnects and rejoins with its token — which no longer has a
    // seat — so ids are handed out fresh in rejoin order. (Any connected
    // socket can send this, the same trust level as set-out-by-id on a
    // performance LAN.)
    socket.on(events.resetIds, async () => {
      console.log("[protocol] resetting all seat assignments");

      seats.clear();
      lastControls.clear();

      for (const entry of registry.list()) {
        registry.release(entry.id);

        await projectAudio.removeVoice(entry.id).catch((error) => {
          console.error(
            `[protocol] failed to release voice for client ${entry.id}:`,
            error,
          );
        });

        // The performer page reconnects and rejoins on its own; the
        // bounce also fires each socket's disconnect handler, which finds
        // the assignment already released and no-ops.
        const performer = io.sockets.sockets.get(entry.socketId);

        if (performer) {
          performer.disconnect(true);
        }
      }

      broadcastState();
    });

    socket.on("disconnect", () => {
      const id = registry.findIdBySocket(socket.id);

      if (id === null) {
        // Not a joined performer — or a takeover already rebound this id
        // to the new socket, whose live voice this must not free.
        return;
      }

      console.log(`[protocol] disconnect: client ${id}`);

      // Persist while the assignment and the voice still exist, then
      // free both.
      persist(id);

      registry.releaseBySocket(socket.id);

      projectAudio
        .removeVoice(id)
        .catch((error) => {
          console.error(
            `[protocol] failed to release voice for client ${id}:`,
            error,
          );
        })
        .finally(() => {
          broadcastState();
        });
    });
  });
}

module.exports = {
  attachProtocol,
};
