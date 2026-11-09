// App owns these listeners. Adopt its descriptors without rebinding a port.
const fs = require("node:fs");
const path = require("node:path");

function readAssignment(value) {
  if (value === undefined) return null;
  const assignment = JSON.parse(value);
  if (!assignment || assignment.version !== 1 ||
      typeof assignment.runId !== "string" || !assignment.runId ||
      typeof assignment.reportPath !== "string" || !path.isAbsolute(assignment.reportPath) ||
      !Array.isArray(assignment.services) || assignment.services.length !== 2 ||
      !["performer", "monitor"].every(role => assignment.services.filter(service =>
        service.role === role && Number.isInteger(service.fd) && service.fd >= 0 &&
        Number.isInteger(service.port) && service.port > 0 && service.port <= 65535).length === 1) ||
      assignment.services[0].fd === assignment.services[1].fd ||
      assignment.services[0].port === assignment.services[1].port) {
    throw new Error("Unsupported PNDS runtime listener assignment.");
  }
  return assignment;
}

function report(assignment, status, error) {
  if (!assignment) return;
  const value = { version: 1, runId: assignment.runId, status,
    services: status === "bound" ? assignment.services.map(({ role, port }) => ({ role, port })) : [],
    ...(error ? { error: String(error.message || error).slice(0, 1000) } : {}),
  };
  const temporary = `${assignment.reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, assignment.reportPath);
}

function listen(server, role, config) {
  const assigned = config.runtimeAssignment?.services.find(service => service.role === role);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(assigned ? { fd: assigned.fd } : { port: config[`${role}Port`], host: "0.0.0.0" }, () => {
      server.removeListener("error", reject);
      if (assigned && server.address().port !== assigned.port) {
        reject(new Error(`App ${role} listener does not match its assigned port.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = { readAssignment, report, listen };
