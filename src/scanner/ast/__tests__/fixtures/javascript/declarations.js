export function declared() {
  return assignedArrow();
}
export class Service {
  run() {
    return this.stop();
  }
  stop() {}
}
const assignedArrow = () => declared();
let assignedFunction = function () {};
var AssignedClass = class {
  method() {}
};
reassignedArrow = () => {};
reassignedFunction = function () {};
ReassignedClass = class {
  method() {}
};
const instance = new Service();
instance.run();
