<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import Visualizer2D from '$lib/components/Visualizer2D.svelte';
	import Visualizer3D_01 from '$lib/components/Visualizer3D_01.svelte';
	import Visualizer3D_02 from '$lib/components/Visualizer3D_02.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';
	import { untrack } from 'svelte';
	import { fade } from 'svelte/transition';

	interface Props {
		currentTrack?: Track | null;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	const totalVisualizers = 3;
	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<AudioNode | null>(null);
	let activeVisualizerIndex = $state(0);
	let isInterfaceHidden = $state(false);
	let hasConnectedAnalyserOutput = $state(false);
	let isShowingControls = $state(false);
	let isHelpActive = $state(false);
	let hideVisualizerName = $state(true);
	let hideVisualizerNameTimeout = $state<number>();

	$effect(() => {
		if (activeVisualizerIndex > -1) {
			untrack(() => {
				hideVisualizerName = false;
				clearTimeout(hideVisualizerNameTimeout);
				hideVisualizerNameTimeout = window.setTimeout(() => {
					hideVisualizerName = true;
				}, 1000);
			});
		}
	});

	const freqLow = 20; // Hz — low frequency cutoff for both visualizers
	const freqHigh = 18000; // Hz — high frequency cutoff for both visualizers

	function isEditableTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		const tagName = target.tagName.toLowerCase();
		return (
			tagName === 'input' ||
			tagName === 'textarea' ||
			tagName === 'select' ||
			target.isContentEditable
		);
	}

	function onVisualizerKeydown(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;

		switch (event.key) {
			case 'i':
				isInterfaceHidden = !isInterfaceHidden;
				break;
			case '1':
			case '2':
			case '3':
				activeVisualizerIndex = Number(event.key) - 1;
				break;
			case 'ArrowRight':
				activeVisualizerIndex = (activeVisualizerIndex + 1) % totalVisualizers;
				break;
			case 'ArrowLeft':
				activeVisualizerIndex = (activeVisualizerIndex - 1 + totalVisualizers) % totalVisualizers;
				break;
			case 'h':
				isHelpActive = !isHelpActive;
				break;
			case 'c':
				isShowingControls = !isShowingControls;
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

	function toggleHelp() {
		isHelpActive = !isHelpActive;
	}
</script>

<svelte:window onkeydown={onVisualizerKeydown} />

{#if activeVisualizerIndex === 1}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Waves</h3>
	{/if}
	<Visualizer3D_01 {currentTrack} {music} {freqLow} {freqHigh} />
{:else if activeVisualizerIndex === 0}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Tunnel</h3>
	{/if}
	<Visualizer3D_02 {currentTrack} {music} {freqLow} {freqHigh} {isShowingControls} />
{:else if activeVisualizerIndex === 2}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Dots and lines</h3>
	{/if}
	<Visualizer2D {currentTrack} {music} {freqLow} {freqHigh} />
{/if}

{#if isHelpActive}
	<div class="help-overlay">
		<p>Keybindings</p>
		<ul>
			<li><span><strong>h</strong></span> Toggle help</li>
			<li><span><strong>i</strong></span> Toggle interface</li>
			<li>
				<span><strong>1</strong>, <strong>2</strong>, <strong>3</strong></span> Choose visualizer
			</li>
			<li>
				<span
					><strong>⬅</strong>
					<strong style="display: inline-block;transform: scaleX(-1);">⬅</strong></span
				> Cycle visualizer
			</li>
			<li><span><strong>c</strong></span> Toggle controls (if available)</li>
			<li><span><strong>Escape</strong></span> Show interface</li>
		</ul>
	</div>
{:else}
	<button
		class="help-toggle"
		class:is-on={isHelpActive}
		class:hidden={isInterfaceHidden}
		onclick={toggleHelp}
		aria-label="Show help"
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 512 512">
			<path d="M0 0h512v512H0z" fill="none" />
			<path
				fill="none"
				stroke="currentColor"
				stroke-linecap="round"
				stroke-miterlimit="10"
				stroke-width="40"
				d="M160 164s1.44-33 33.54-59.46C212.6 88.83 235.49 84.28 256 84c18.73-.23 35.47 2.94 45.48 7.82C318.59 100.2 352 120.6 352 164c0 45.67-29.18 66.37-62.35 89.18S248 298.36 248 324"
			/>
			<circle cx="248" cy="399.99" r="32" fill="currentColor" />
		</svg>
	</button>
{/if}
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
	.help-toggle {
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
	.name {
		position: fixed;
		left: 50%;
		top: 20px;
		transform: translate(-50%, 0);
		width: fit-content;
		background: black;
		padding: 6px;
		color: white;
		font-size: 12px;
		font-family: monospace;
		z-index: 3;
		transition: opacity 0.5s ease 1s;
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
	.help-toggle {
		position: fixed;
		top: 10px;
		right: 10px;
		z-index: 2;
		background: black;
		padding: 4px;
		outline: none;
		color: white;
		border: 1px solid rgb(255 255 255 / 0.2);
		border-radius: 100px;
		display: flex;
		--highlight: rgb(255, 135, 255);
	}
	.help-toggle:hover,
	.help-toggle:focus-visible {
		border-color: white;
	}
	.help-toggle.is-on {
		color: var(--highlight);
		border-color: color-mix(in srgb, var(--highlight), transparent 60%);
	}
	.help-toggle.is-on:hover,
	.help-toggle.is-on:focus-visible {
		border-color: var(--highlight);
	}

	.help-overlay {
		position: fixed;
		top: 12px;
		right: 12px;
		background: rgba(0, 0, 0, 0.8);
		color: white;
		padding: 20px;
		font-family: monospace;
		font-size: 12px;
		z-index: 5;
	}
	.help-overlay p {
		margin: 0 0 12px;
		text-decoration: underline;
	}
	.help-overlay ul {
		list-style-type: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.help-overlay li {
		display: flex;
		gap: 12px;
	}
</style>
