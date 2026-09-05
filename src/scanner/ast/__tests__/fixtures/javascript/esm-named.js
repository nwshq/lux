import base, { alpha as localAlpha, beta } from './named.js';
import * as namespace from './namespace.js';
export const own = () => base();
export { localAlpha as alpha, beta };
const lazy = import('./lazy.js');
