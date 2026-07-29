import { loadNativeModule } from './nativeModuleLoader';

// NativeModule may be null if the Rust binary isn't built yet (new clone without `npm run build:native`).
// All methods below handle this gracefully by returning empty arrays.
const NativeModule: any = loadNativeModule();
const { getInputDevices, getOutputDevices } = NativeModule || {};

export interface AudioDevice {
    id: string;
    name: string;
}

export interface AudioDeviceEnumeration {
    devices: AudioDevice[];
    ok: boolean;
}

export class AudioDevices {
    public static isNativeModuleAvailable(): boolean {
        return typeof getInputDevices === 'function' && typeof getOutputDevices === 'function';
    }

    public static enumerateInputDevices(): AudioDeviceEnumeration {
        if (!getInputDevices) {
            console.warn('[AudioDevices] Native input-device functionality not available');
            return { devices: [], ok: false };
        }
        try {
            return { devices: getInputDevices(), ok: true };
        } catch (e) {
            console.error('[AudioDevices] Failed to get input devices:', e);
            return { devices: [], ok: false };
        }
    }

    public static enumerateOutputDevices(): AudioDeviceEnumeration {
        if (!getOutputDevices) {
            console.warn('[AudioDevices] Native output-device functionality not available');
            return { devices: [], ok: false };
        }
        try {
            return { devices: getOutputDevices(), ok: true };
        } catch (e) {
            console.error('[AudioDevices] Failed to get output devices:', e);
            return { devices: [], ok: false };
        }
    }

    public static getInputDevices(): AudioDevice[] {
        return this.enumerateInputDevices().devices;
    }

    public static getOutputDevices(): AudioDevice[] {
        return this.enumerateOutputDevices().devices;
    }
}
