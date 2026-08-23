// Score-server client for the browser pages.
//
// Works as a plain browser global (window.PNDSClient) and as a Node
// module (tests). Everything the pages used to inline lives here: the
// performer-port URL, socket reconnection, the join-with-persisted-token
// / rejoin-on-reconnect flow, my-voice tracking from state broadcasts,
// and the send-only-if-changed deadband. Pages keep drawing and input.
//
// Like lib/protocol.js on the server side, this module holds no work
// vocabulary: control payloads pass through the deadband and the wire
// opaquely, and event names come from shared.js via the caller.
//
// All ambient dependencies are injected ({ io, storage, hostname }), so
// tests drive the same code with a fake socket factory and a fake
// storage — no browser needed.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.PNDSClient = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The performer server's origin — the one URL both pages and the
  // socket.io script tag are built from.
  function socketOrigin({ hostname, port }) {
    return "http://" + hostname + ":" + port;
  }

  // True when any field of `next` differs from `previous`: numeric
  // fields compare against the deadband threshold, everything else
  // strictly. Work-agnostic — the field names are the caller's.
  function changedBeyond(previous, next, threshold) {
    const before = previous || {};
    const keys = new Set([...Object.keys(before), ...Object.keys(next)]);

    for (const key of keys) {
      const a = before[key];
      const b = next[key];

      if (typeof a === "number" && typeof b === "number") {
        if (Math.abs(a - b) >= threshold) {
          return true;
        }
      } else if (!Object.is(a, b)) {
        return true;
      }
    }

    return false;
  }

  function connectSocket({ io, port, hostname, reconnectionDelay = 1000 }) {
    return io(socketOrigin({ hostname, port }), {
      reconnection: true,
      reconnectionDelay,
    });
  }

  // The performer page's connection: joins with the persisted claim
  // token (re-emitting it on every reconnect, so the server hands back
  // the same client id and the restored voice state), tracks this
  // voice's output channel from state broadcasts, and sends controls
  // only when they changed.
  function connectPerformer({
    io,
    port,
    events,
    tokenKey,
    storage,
    hostname,
    reconnectionDelay,
    sendThreshold = 0.002,
  }) {
    if (!storage) {
      throw new Error("connectPerformer needs a storage (localStorage in the browser)");
    }

    const socket = connectSocket({ io, port, hostname, reconnectionDelay });

    const state = {
      joined: false,
      myId: null,
      myOut: null, // arrives with the first state broadcast
      rejectedReason: null,
    };

    socket.on(events.joined, (data) => {
      state.joined = true;
      state.myId = data.id;
      state.myOut = null;
      state.rejectedReason = null;
      storage.setItem(tokenKey, data.token);
    });

    socket.on(events.rejected, (data) => {
      state.joined = false;
      state.myId = null;
      state.myOut = null;
      state.rejectedReason = (data && data.reason) || "Rejected";
    });

    // Track this voice's output channel from the state broadcasts, so
    // the status line follows channel reassignments made on the monitor
    // page.
    socket.on(events.state, (data) => {
      if (state.myId === null) {
        return;
      }

      const mine = ((data && data.clients) || []).find(
        (client) => client.id === state.myId,
      );

      state.myOut = mine ? mine.out : null;
    });

    socket.on("connect", () => {
      // Fires on first connect and after every reconnect: (re)join with
      // the persisted token so the server hands back the same client id.
      socket.emit(events.join, {
        token: storage.getItem(tokenKey) || null,
      });
    });

    socket.on("disconnect", () => {
      state.joined = false;
    });

    let lastSent = null;

    return {
      get connected() {
        return socket.connected;
      },
      get joined() {
        return state.joined;
      },
      get myId() {
        return state.myId;
      },
      get myOut() {
        return state.myOut;
      },
      get rejectedReason() {
        return state.rejectedReason;
      },

      // Deadband-deduped control send. Returns whether the payload went
      // out; no-ops while not joined.
      sendControls(payload) {
        if (!state.joined) {
          return false;
        }

        if (!changedBeyond(lastSent, payload, sendThreshold)) {
          return false;
        }

        lastSent = { ...payload };
        socket.emit(events.control, payload);
        return true;
      },

      // Ends the connection (page unload; tests release the socket).
      close() {
        socket.close();
      },
    };
  }

  // The monitor page's connection: an observer that never joins — it
  // sees every state broadcast and can reassign a client's output
  // channel by naming the id.
  function connectMonitor({ io, port, events, hostname, reconnectionDelay }) {
    const socket = connectSocket({ io, port, hostname, reconnectionDelay });
    const listeners = [];
    let clients = [];

    socket.on(events.state, (data) => {
      clients = (data && data.clients) || [];

      for (const listener of listeners) {
        listener(clients);
      }
    });

    return {
      get connected() {
        return socket.connected;
      },
      get clients() {
        return clients;
      },

      onClients(listener) {
        listeners.push(listener);
      },

      setOut(id, out) {
        socket.emit(events.setOut, { id, out });
      },

      // The monitor's seat move: the server reassigns the device to the
      // target seat number (must be free of live devices).
      setSeat(id, to) {
        socket.emit(events.setSeat, { id, to });
      },

      // The monitor's reset button: the server wipes every seat record
      // and bounces the performers, who rejoin with fresh ids.
      resetIds() {
        socket.emit(events.resetIds);
      },

      close() {
        socket.close();
      },
    };
  }

  return {
    connectPerformer,
    connectMonitor,
    socketOrigin,
  };
});
