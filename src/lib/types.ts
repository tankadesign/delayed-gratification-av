export interface Track {
	id: string;
	name: string;
	file: string;
	isPlaying: boolean;
	released: string;
	hue: number;
}

export interface TrackAudio {
	audioEl: HTMLAudioElement;
	audioSource: AudioNode | null;
}
