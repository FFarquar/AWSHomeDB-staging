// Namespaces localStorage auth keys by ENVIRONMENT so staging and prod
// (served from the same origin, different paths) don't clobber each other's auth.
// Kept separate from config.js because CI/CD regenerates config.js from
// scratch on every deploy (see .github/workflows/deploy.yml) and would wipe
// this out if it lived there.
window.authStorageKey = function (name) {
  return name + ':' + (window.APP_CONFIG.ENVIRONMENT || 'LOCAL');
};
