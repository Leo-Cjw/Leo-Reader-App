const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const plistBuddy = '/usr/libexec/PlistBuddy';

function run(plistPath, command, optional = false) {
  const result = spawnSync(plistBuddy, ['-c', command, plistPath], { encoding: 'utf8' });
  if (!optional && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `PlistBuddy failed: ${command}`);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appContents = path.join(context.appOutDir, `${appName}.app`, 'Contents');
  const plistPath = path.join(appContents, 'Info.plist');
  const shareExtension = path.join(context.packager.projectDir, 'build', 'Reader Share Extension.appex');
  const shareDestination = path.join(appContents, 'PlugIns', 'Reader Share Extension.appex');

  fs.mkdirSync(path.dirname(shareDestination), { recursive: true });
  fs.cpSync(shareExtension, shareDestination, { recursive: true });

  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ]) run(plistPath, `Delete :${key}`, true);

  run(plistPath, 'Delete :NSAppTransportSecurity', true);
  run(plistPath, 'Add :NSAppTransportSecurity dict');
  run(plistPath, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false');
  run(plistPath, 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true');
  run(plistPath, 'Add :NSAppTransportSecurity:NSExceptionDomains dict');
  run(plistPath, 'Add :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1 dict');
  run(plistPath, 'Add :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1:NSIncludesSubdomains bool false');
  run(plistPath, 'Add :NSAppTransportSecurity:NSExceptionDomains:127.0.0.1:NSTemporaryExceptionAllowsInsecureHTTPLoads bool true');
  run(plistPath, 'Delete :NSUserActivityTypes', true);
  run(plistPath, 'Add :NSUserActivityTypes array');
  run(plistPath, 'Add :NSUserActivityTypes:0 string com.apple.corespotlightitem');
};
