import { logEvent, type Analytics } from 'firebase/analytics';

class LocalStore {
	currentAudio = $state<HTMLAudioElement | null>(null);
	audioContext = $state<AudioContext | null>(null);
	analyser = $state<AnalyserNode | null>(null);

	bars = 128 as const;

	ga = $state<Analytics | null>(null);

	logEvent(name: string, params?: { [key: string]: string | number }) {
		if (this.ga) {
			logEvent(this.ga, name, params);
		}
	}
}

export const store = new LocalStore();
