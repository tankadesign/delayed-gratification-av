export interface Track {
	id: string;
	name: string;
	file: string;
	isPlaying: boolean;
	released: string;
	hue: number;
	beatConfig?: BeatConfig;
}

export interface TrackAudio {
	audioEl: HTMLAudioElement;
	audioSource: MediaElementAudioSourceNode | null;
}

export interface BeatConfig {
	downbeatMinHz: number;
	downbeatMaxHz: number;
	downbeatThreshold: number;
	downbeatMinEnergy: number;
	downbeatBurstDesktop: number;
	downbeatBurstMobile: number;
	downbeatBurstMaxDesktop: number;
	downbeatBurstMaxMobile: number;
	accentMinHz: number;
	accentMaxHz: number;
	accentThreshold: number;
	accentMinEnergy: number;
	accentBurstDesktop: number;
	accentBurstMobile: number;
	accentBurstMaxDesktop: number;
	accentBurstMaxMobile: number;
	bpmMin: number;
	bpmMax: number;
	targetBpm: number;
	bpmTimingTolerance: number;
	bpmLockStrength: number;
}
