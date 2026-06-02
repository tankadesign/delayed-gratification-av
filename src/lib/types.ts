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
	audioSource: AudioNode | null;
}

export interface TunnelConfig {
	slices: number;
	segments: number;
	emitIntervalSeconds: number;
	lifetimeSeconds: number;
	depth: number;
	nearZ: number;
	cameraZ: number;
	curve: {
		sourceRenderMode: number;
		ringRadiusDesktop: number;
		ringRadiusMobile: number;
		lineThicknessDesktop: number;
		lineThicknessMobile: number;
		amplitudeDesktop: number;
		amplitudeMobile: number;
		baselineY: number;
		smoothing: number;
		endFade: number;
		morphStrength: number;
		twist: number;
	};
	emission: {
		gapModAmount: number;
		gapModNoiseSpeed: number;
		gapModNoiseContrast: number;
		curvePower: number;
		zRotationSpeed: number;
		gradientCycleSpeed: number;
	};
	ghost: {
		enabled: number;
		opacity: number;
		scale: number;
		blurWidth: number;
		thicknessMultiplier: number;
		warp: number;
		twistOffset: number;
		zOffset: number;
	};
	particle: {
		radius: number;
		count: number;
		radiusVariability: number;
		randomness: number;
		offset: number;
		moveSpeed: number;
	};
	bend: {
		amount: number;
		noiseSpeed: number;
		depthStrength: number;
	};
}
