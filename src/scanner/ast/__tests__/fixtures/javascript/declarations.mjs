export default class ModuleClass { start() { return helper(); } }
export function helper() {}
export const arrow = () => new ModuleClass();
