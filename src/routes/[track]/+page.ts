import { tracks } from '$lib/tracks';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params }) => {
	const track = tracks.find((track) => track.id === params.track);
	if (!track) {
		throw error(404, 'Track not found');
	}
	return {
		track
	};
};
