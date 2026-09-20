const fs = require('fs');
const path = require('path');
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins');

const RINGER_MODE_MODULE = `package com.onnremote.app

import android.content.Context
import android.media.AudioManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.uimanager.ViewManager

class RingerModeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "RingerMode"

  @ReactMethod
  fun isVibrateMode(promise: Promise) {
    val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    promise.resolve(audioManager.ringerMode == AudioManager.RINGER_MODE_VIBRATE)
  }
}

class RingerModePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(RingerModeModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
`;

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

  config = withDangerousMod(config, ['android', (config) => {
    const packagePath = (config.android.package || 'com.onnremote.app').split('.');
    const sourceDirectory = path.join(
      config.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'java',
      ...packagePath
    );
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, 'RingerModeModule.kt'), RINGER_MODE_MODULE);
    return config;
  }]);

  return withMainApplication(config, (config) => {
    if (config.modResults.language !== 'kt') return config;
    const marker = '// add(MyReactNativePackage())';
    if (!config.modResults.contents.includes('add(RingerModePackage())')) {
      config.modResults.contents = config.modResults.contents.replace(
        marker,
        `${marker}\n          add(RingerModePackage())`
      );
    }
    return config;
  });
};
