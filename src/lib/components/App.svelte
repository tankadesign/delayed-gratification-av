<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import VisualizerDotsAndLines from '$lib/components/visualizers/DotsAndLines.svelte';
	import VisualizerWaves from '$lib/components/visualizers/Waves.svelte';
	import VisualizerTunnel from '$lib/components/visualizers/Tunnel.svelte';
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
	let didChooseVisualizer = $state(false);

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
	const tunnelConfig = {};

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
				toggleInterface();
				break;
			case '1':
			case '2':
			case '3':
				activeVisualizerIndex = Number(event.key) - 1;
				didChooseVisualizer = true;
				break;
			case 'ArrowRight':
				skipVisualizer(1);
				didChooseVisualizer = true;
				break;
			case 'ArrowLeft':
				skipVisualizer(-1);
				didChooseVisualizer = true;
				break;
			case 'h':
				toggleHelp();
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
			console.log('Skipped to next track:', tracks[next].name);
			if (!didChooseVisualizer) {
				skipVisualizer(1);
			}
		}
	}

	function skipVisualizer(delta: number) {
		activeVisualizerIndex = (activeVisualizerIndex + delta + totalVisualizers) % totalVisualizers;
		console.log('Switched to visualizer index', activeVisualizerIndex);
	}

	function toggleHelp() {
		isHelpActive = !isHelpActive;
	}

	function toggleInterface() {
		isInterfaceHidden = !isInterfaceHidden;
	}
</script>

<svelte:window onkeydown={onVisualizerKeydown} />

{#if activeVisualizerIndex === 1}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Waves</h3>
	{/if}
	<VisualizerWaves {currentTrack} {music} {freqLow} {freqHigh} />
{:else if activeVisualizerIndex === 0}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Tunnel</h3>
	{/if}
	<VisualizerTunnel
		{currentTrack}
		{music}
		{freqLow}
		{freqHigh}
		{isShowingControls}
		config={tunnelConfig}
	/>
{:else if activeVisualizerIndex === 2}
	{#if !hideVisualizerName}
		<h3 class="name" out:fade>Dots and lines</h3>
	{/if}
	<VisualizerDotsAndLines {currentTrack} {music} {freqLow} {freqHigh} />
{/if}

{#if isHelpActive}
	<div class="help-overlay">
		<p>Keybindings</p>
		<ul>
			<li><span><strong>h</strong></span> <button onclick={toggleHelp}>Toggle help</button></li>
			<li>
				<span><strong>i</strong></span> <button onclick={toggleInterface}>Toggle interface</button>
			</li>
			<li>
				<span><strong>1</strong><strong>2</strong><strong>3</strong></span> Choose visualizer
			</li>
			<li>
				<span
					><strong>⬅</strong>
					<strong style="display: inline-block;transform: scaleX(-1);">⬅</strong></span
				> <button onclick={() => skipVisualizer(1)}>Cycle visualizer</button>
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
		aria-label="Show help">?</button
	>
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
		font-family: var(--zendots);
		text-align: center;
	}
	h2 {
		font-size: 1.5rem;
		font-family: var(--zendots);
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
		font-family: var(--monospace);
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

	.help-overlay {
		position: fixed;
		top: 12px;
		right: 12px;
		background: rgba(0, 0, 0, 0.8);
		color: white;
		padding: 20px;
		font-family: var(--monospace);
		font-size: 12px;
		z-index: 5;
	}
	.help-overlay p {
		margin: 0 0 12px;
		font-weight: bold;
	}
	.help-overlay ul {
		list-style-type: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.help-overlay li {
		display: flex;
		gap: 12px;
		align-items: center;
	}
	.help-overlay span {
		display: inline-flex;
		gap: 4px;
	}
	.help-overlay button {
		border: 0;
		color: white;
		background: none;
		margin: 0;
		padding: 0;
		outline: none;
		text-decoration: underline;
		text-underline-offset: 4px;
		text-decoration-thickness: 0.5px;
		text-decoration-color: rgba(255, 255, 255, 0.5);
		font-weight: normal;
		cursor: pointer;
	}
	.help-toggle,
	.help-overlay strong {
		display: inline-block;
		border: 1px solid rgba(255, 255, 255, 0.3);
		padding: 2px 4px;
		border-radius: 2px;
		min-width: 18px;
		text-align: center;
		color: white;
	}

	.help-toggle {
		position: fixed;
		top: 10px;
		right: 10px;
		z-index: 2;
		background: black;
		text-decoration: none;
		outline: none;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		width: 22px;
		font-family: var(--monospace);
		font-weight: bold;
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
</style>
