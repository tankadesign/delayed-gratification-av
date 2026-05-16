import type { Track } from './types';

export const tracks: Track[] = [
	{
		id: 'club-foot',
		name: 'Club Foot',
		file: '/Club_Foot.m4a',
		isPlaying: false,
		released: 'March 26th, 2024',
		gradientStops: ['#ff184c', '#FF8661', '#18C1FF', '#FE35F1', '#D261FF'],
		bpm: 108
	},
	{
		id: 'gtnw',
		name: 'GTNW',
		file: '/GTNW.m4a',
		isPlaying: false,
		released: 'January 20th, 2024',
		gradientStops: ['#FF1500', '#F5B546', '#ff4b00', '#ffb000', '#fff3a0'],
		bpm: 86
	},
	{
		id: 'connecting-dots',
		name: 'Connecting Dots',
		file: '/Connecting_Dots.m4a',
		isPlaying: false,
		released: 'September 18th, 2023',
		gradientStops: ['#59F9FF', '#0a5cff', '#00d4ff', '#59F9FF', '#0a5cff', '#00d4ff'],
		bpm: 105
	},
	{
		id: 'delayed-gratification',
		name: 'Delayed Gratification',
		file: '/Delayed_Gratification.m4a',
		isPlaying: false,
		released: 'September 1st, 2023',
		gradientStops: ['#752CFB', '#e33f7f', '#ffb45c', '#6ef3c5'],
		bpm: 116
	}
];
