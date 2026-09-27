const { withAndroidManifest } = require('@expo/config-plugins');

// Roku ECP usa HTTP local (http://IP_DE_LA_TV:8060). Android bloquea HTTP en
// builds Release por defecto, aunque Expo Go sí lo permita. Este plugin añade
// la excepción al manifiesto final que se genera en GitHub Actions.
module.exports = function withRokuLocalHttp(config) {
  config = withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return config;
  });

  return config;
};
