<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { tracks } from '$lib/tracks';
	import { formatTime } from '$lib/util';

	let isPlaying = $state(false);
	let audioEl = $state<HTMLAudioElement | null>(null);
	let audioFile = $state('');
	let time = $state(0);
	let duration = $state(0);

	let timeFormatted = $derived(formatTime(time));
	let durationFormatted = $derived(formatTime(duration));

	let currentTrackId = $derived(page.params.track);
	let currentTrack = $derived(tracks.find((t) => t.id === currentTrackId));
	let name = $derived(currentTrack?.name);

	function loadAudio() {
		duration = audioEl!.duration;
	}
	afterNavigate(() => {
		audioFile = currentTrack?.file ?? '';
	});
</script>

<div class="player">
	<h3>{name ?? 'Select...'}</h3>
	<audio
		bind:this={audioEl}
		src={audioFile}
		onloadedmetadata={loadAudio}
		ontimeupdate={() => {
			if (audioEl) {
				time = audioEl.currentTime;
			}
		}}
		onplaying={() => {
			isPlaying = true;
		}}
		onpause={() => {
			isPlaying = false;
		}}
		preload="metadata"
		mediagroup="tracks"
	></audio>
</div>

<style>
	.player {
		color: white;
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 2;
		background: rgba(10, 7, 73, 0.58);
	}
</style>
