<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import Visualizer2D from '$lib/components/Visualizer2D.svelte';
	import Visualizer3D_01 from '$lib/components/Visualizer3D_01.svelte';
	import Visualizer3D_02 from '$lib/components/Visualizer3D_02.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';

	interface Props {
		currentTrack?: Track | null;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	const totalVisualizers = 3;
	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<AudioNode | null>(null);
	let activeVisualizerIndex = $state(1);
	let isInterfaceHidden = $state(false);
	let hasConnectedAnalyserOutput = $state(false);

	const freqLow = 20; // Hz — low frequency cutoff for both visualizers
	const freqHigh = 18000; // Hz — high frequency cutoff for both visualizers

	function onVisualizerKeydown(event: KeyboardEvent) {
		switch (event.key) {
			case 'i':
				isInterfaceHidden = !isInterfaceHidden;
				break;
			case '1':
			case '2':
			case '3':
				activeVisualizerIndex = Number(event.key) - 1;
				break;
			case '+':
				activeVisualizerIndex = (activeVisualizerIndex + 1) % totalVisualizers;
				break;
			case '-':
				activeVisualizerIndex = (activeVisualizerIndex - 1 + totalVisualizers) % totalVisualizers;
				break;
			case 'Escape':
				isInterfaceHidden = false;
				break;
		}
	}

	async function play() {
		if (!music) {
			console.log('no music');
			return;
		}

		if (store.audioContext && store.analyser && audioSource) {
			try {
				audioSource.connect(store.analyser);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
			} catch (error) {
				// Ignore duplicate audio graph connections.
			}

			if (!hasConnectedAnalyserOutput) {
				store.analyser.connect(store.audioContext.destination);
				hasConnectedAnalyserOutput = true;
			}

			if (store.audioContext.state === 'suspended') {
				await store.audioContext.resume();
			}
		}

		music.volume = 1;
		await music.play();
	}

	function onPlayTrack(audio: TrackAudio, track: Track) {
		currentTrack = track;
		music?.pause();
		music = audio.audioEl;
		audioSource = audio.audioSource;
		for (const t of tracks) {
			if (t === track) t.isPlaying = true;
			else t.isPlaying = false;
		}
		play();
	}

	function skipToNextTrack() {
		const index = tracks.findIndex((t) => t.id === currentTrack?.id);
		const next = (index + 1) % tracks.length;
		const track = document.querySelector('#track-' + tracks[next].id + ' button');
		if (track) {
			(track as HTMLButtonElement).click();
		}
	}

	function switchDimension() {
		activeVisualizerIndex = activeVisualizerIndex === 0 ? 1 : 0;
	}
</script>

<svelte:window onkeydown={onVisualizerKeydown} />

{#if activeVisualizerIndex === 0}
	<Visualizer3D_01 {currentTrack} {music} {freqLow} {freqHigh} />
{:else if activeVisualizerIndex === 1}
	<Visualizer3D_02 {currentTrack} {music} {freqLow} {freqHigh} />
{:else if activeVisualizerIndex === 2}
	<Visualizer2D {currentTrack} {music} {freqLow} {freqHigh} />
{/if}
<button
	class="dimension-switch"
	class:is-3d={activeVisualizerIndex === 0}
	class:hidden={isInterfaceHidden}
	onclick={switchDimension}
	aria-label={activeVisualizerIndex === 2 ? 'Switch to 3D visualizer' : 'Switch to 2D visualizer'}
>
	<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
		<path d="M0 0h24v24H0z" fill="none" />
		<path
			fill="none"
			stroke="currentColor"
			stroke-linejoin="round"
			d="M12 21v-8m0 8l-6.162-4.402c-.411-.293-.616-.44-.727-.655S5 15.475 5 14.971V8m7 13l6.163-4.402c.41-.293.615-.44.726-.655s.111-.468.111-.972V8m-7 5L5 8m7 5l7-5M5 8l5.838-4.17c.56-.4.842-.601 1.162-.601s.601.2 1.162.601L19 8"
		/>
	</svg>
</button>
<div class="wrap" class:hidden={isInterfaceHidden}>
	<div class="text">
		<h1>j.Falcon</h1>
		<h2>Undefined</h2>
	</div>
	<div class="list">
		{#each tracks as track (track.id)}
			<TrackComponent
				{track}
				isSelected={track.id === currentTrack?.id}
				on:play={(e) => {
					onPlayTrack(e.detail, track);
				}}
				on:end={() => {
					skipToNextTrack();
				}}
			/>
		{/each}
	</div>
</div>

<style>
	.wrap {
		display: flex;
		flex-direction: column;
		position: relative;
		z-index: 1;
	}
	.wrap,
	.dimension-switch {
		transition: opacity 0.5s ease;
	}
	.hidden {
		opacity: 0;
		pointer-events: none;
	}
	.list {
		max-width: 440px;
		width: 100%;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	h1 {
		position: relative;
		z-index: 1;
		font-size: 4rem;
		margin: 0;
		line-height: 1;
		font-family: 'Zen Dots';
		text-align: center;
	}
	h2 {
		font-size: 1.5rem;
		font-family: 'Zen Dots';
		width: 320px;
		margin: 0 auto;
		font-weight: 300;
		text-align: right;
		transform: translate(-4%, -30%);
	}
	h1,
	h2 {
		text-shadow: 0 3px 15px rgba(0, 0, 0, 0.5);
	}
	.text {
		color: white;
	}
	@media (min-width: 560px) {
		h1 {
			font-size: 7rem;
		}
		h2 {
			font-size: 3rem;
			transform: translate(-2px, -40%);
			width: 100%;
		}
	}
	@media (min-width: 900px) {
		h1 {
			font-size: 10rem;
		}
		h2 {
			transform: translate(-5px, -50%);
		}
	}
	.dimension-switch {
		position: fixed;
		top: 10px;
		right: 10px;
		z-index: 2;
		background: black;
		padding: 8px;
		font-size: 12px;
		outline: none;
		color: white;
		border: 1px solid rgb(255 255 255 / 0.2);
		--highlight: #87bdff;
	}
	.dimension-switch:hover,
	.dimension-switch:focus-visible {
		border-color: white;
	}
	.dimension-switch.is-3d {
		color: var(--highlight);
		border-color: color-mix(in srgb, var(--highlight), transparent 60%);
	}
	.dimension-switch.is-3d:hover,
	.dimension-switch.is-3d:focus-visible {
		border-color: var(--highlight);
	}
</style>
