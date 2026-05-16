export interface Track {
	id: string;
	name: string;
	file: string;
	isPlaying: boolean;
	released: string;
	hue: number;
	gradientStops: string[];
	bpm: number;
}

export interface TrackAudio {
	audioEl: HTMLAudioElement;
	audioSource: MediaElementAudioSourceNode | null;
}
