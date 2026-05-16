<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import Visualizer2D from '$lib/components/Visualizer2D.svelte';
	import Visualizer3D from '$lib/components/Visualizer3D.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';
	import { onMount } from 'svelte';

	interface Props {
		currentTrack?: Track | null;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<AudioNode | null>(null);
	let activeVisualizer = $state<'2d' | '3d'>('2d');
	let typedVisualizerCommand = '';
	let hasConnectedAnalyserOutput = false;

	onMount(() => {
		activeVisualizer = '2d';
	});

	function onVisualizerKeydown(event: KeyboardEvent) {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key.length !== 1) return;

		typedVisualizerCommand = (typedVisualizerCommand + event.key.toLowerCase()).slice(-2);
		if (typedVisualizerCommand === '3d') {
			activeVisualizer = '3d';
			typedVisualizerCommand = '';
		} else if (typedVisualizerCommand === '2d') {
			activeVisualizer = '2d';
			typedVisualizerCommand = '';
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
		activeVisualizer = activeVisualizer === '2d' ? '3d' : '2d';
		typedVisualizerCommand = '';
	}
</script>

<svelte:window onkeydown={onVisualizerKeydown} />

{#if activeVisualizer === '3d'}
	<Visualizer3D {currentTrack} {music} />
{:else}
	<Visualizer2D {currentTrack} {music} />
{/if}
<button
	class="dimension-switch"
	class:is-3d={activeVisualizer === '3d'}
	onclick={switchDimension}
	aria-label={activeVisualizer === '2d' ? 'Switch to 3D visualizer' : 'Switch to 2D visualizer'}
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
<div class="wrap">
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
		--highlight: #87bdff;
	}
	.dimension-switch:hover,
	.dimension-switch:focus-visible {
		border-color: white;
	}
	.dimension-switch.is-3d {
		color: var(--highlight);
		border-color: transparent;
	}
	.dimension-switch.is-3d:focus-visible {
		border-color: var(--highlight);
	}
</style>
