import type { BeatConfig, Track } from './types';

export const defaultBeatConfig: BeatConfig = {
	downbeatMinHz: 45,
	downbeatMaxHz: 145,
	downbeatThreshold: 1.18,
	downbeatMinEnergy: 0.035,
	downbeatBurstDesktop: 72,
	downbeatBurstMobile: 16,
	downbeatBurstMaxDesktop: 220,
	downbeatBurstMaxMobile: 70,
	accentMinHz: 160,
	accentMaxHz: 2600,
	accentThreshold: 1.16,
	accentMinEnergy: 0.028,
	accentBurstDesktop: 38,
	accentBurstMobile: 10,
	accentBurstMaxDesktop: 180,
	accentBurstMaxMobile: 58,
	bpmMin: 60,
	bpmMax: 135,
	targetBpm: 0,
	bpmTimingTolerance: 0.24,
	bpmLockStrength: 0.12
};

export const tracks: Track[] = [
	{
		id: 'club-foot',
		name: 'Club Foot',
		file: '/Club_Foot.m4a',
		isPlaying: false,
		released: 'March 26th, 2024',
		hue: 180,
		beatConfig: { ...defaultBeatConfig, targetBpm: 108, bpmMin: 90, bpmMax: 125 }
	},
	{
		id: 'gtnw',
		name: 'GTNW',
		file: '/GTNW.m4a',
		isPlaying: false,
		released: 'January 20th, 2024',
		hue: 5,
		beatConfig: { ...defaultBeatConfig, targetBpm: 86, bpmMin: 70, bpmMax: 105 }
	},
	{
		id: 'connecting-dots',
		name: 'Connecting Dots',
		file: '/Connecting_Dots.m4a',
		isPlaying: false,
		released: 'September 18th, 2023',
		hue: 50,
		beatConfig: { ...defaultBeatConfig, targetBpm: 105, bpmMin: 96, bpmMax: 116 }
	},
	{
		id: 'delayed-gratification',
		name: 'Delayed Gratification',
		file: '/Delayed_Gratification.m4a',
		isPlaying: false,
		released: 'September 1st, 2023',
		hue: 150,
		beatConfig: { ...defaultBeatConfig, targetBpm: 116, bpmMin: 108, bpmMax: 124 }
	}
];
