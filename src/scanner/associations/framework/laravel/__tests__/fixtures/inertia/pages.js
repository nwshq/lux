import Welcome from './Pages/Welcome.vue';
const localPages = import.meta.glob('./Pages/**/*.vue');
const moduleImports = {
  contact: import.meta.glob('@contact/**/*.vue'),
};
const moduleMap = {
  '@contact': moduleImports.contact,
};
const dynamic = import.meta.glob(pagePattern);
export function resolve(name) {
  throw new Error(name);
}
