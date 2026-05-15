<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';
	import { gsap } from 'gsap';
	import {
		Application,
		BlurFilter,
		Container,
		Graphics,
		NoiseFilter,
		RenderTexture,
		Sprite
	} from 'pixi.js';
	import { onMount } from 'svelte';

	interface Props {
		currentTrack?: Track | null;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<MediaElementAudioSourceNode | null>(null);
	let bufferLength = $state(0);
	let dataArray = $state<Uint8Array<ArrayBuffer> | null>(null);
	let canvasEl = $state<HTMLCanvasElement>();
	let xDistance = $state(250);
	let innerWidth = $state(typeof window === 'undefined' ? 393 : window.innerWidth);
	let innerHeight = $state(typeof window === 'undefined' ? 660 : window.innerHeight);

	let isMobile = $derived(innerWidth < 560);

	function getResolution() {
		const devicePixelRatio = typeof window === 'undefined' ? 2 : window.devicePixelRatio;
		return Math.min(2, devicePixelRatio);
	}

	function getCanvasSize() {
		const main = document.querySelector('main');
		const size = {
			width: main?.clientWidth ?? window.innerWidth,
			height: main?.clientHeight ?? window.innerHeight
		};
		return size;
	}

	async function initGraphics() {
		const app = new Application();

		// Detect Safari and use auto preference (falls back to WebGL) for better compatibility
		const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

		await app.init({
			background: '#002',
			antialias: true,
			resolution: getResolution(),
			canvas: canvasEl,
			width: getCanvasSize().width,
			height: getCanvasSize().height,
			preference: isSafari ? 'webgl' : 'webgpu'
		});
		const stageSize = {
			width: app.screen.width,
			height: app.screen.height
		};
		window.addEventListener('resize', () => {
			const { width, height } = getCanvasSize();
			stageSize.width = width;
			stageSize.height = height;
			app.canvas.width = width * getResolution();
			app.canvas.height = height * getResolution();
		});

		document.body.append(app.canvas as HTMLCanvasElement);
		const container = new Container();
		let renderTexture = RenderTexture.create(stageSize);
		let renderTexture2 = RenderTexture.create(stageSize);
		const currentTexture = renderTexture;

		const outputSprite = new Sprite(currentTexture);
		outputSprite.width = stageSize.width;
		outputSprite.height = stageSize.height;
		outputSprite.anchor.set(0.5);
		app.stage.addChild(outputSprite);

		const left = new Graphics();
		const right = new Graphics();
		const circles = new Container();
		container.addChild(circles);
		container.addChild(left);
		container.addChild(right);
		left.blendMode = 'add';
		right.blendMode = 'add';
		right.scale.x = -1;

		app.stage.addChild(container);

		const noise = new NoiseFilter({ seed: 1354, noise: 0.08 });
		const blur = new BlurFilter({ strength: 2 });
		// Apply blur as post-effect to entire layer for better performance
		circles.filters = [blur, noise];

		app.ticker.add(() => {
			if (store.analyser && dataArray) {
				store.analyser.getByteFrequencyData(dataArray);
				xDistance = Math.random() < 0.03 ? 1500 : 250;
				let forceFire = false;
				let canFire = Math.random() < 0.7;
				drawLines(left, right);
				for (let i = 0; i < bufferLength; i++) {
					const h = dataArray[i];
					const pct = h / 255;

					if (i === Math.round(bufferLength * 0.55) && pct > 0.6) {
						xDistance = 1500;
						forceFire = Math.random() < 0.65;
					}

					canFire = canFire && pct > 0.6 && Math.random() < 0.6;
					if (canFire || forceFire) {
						createCircle(pct, stageSize.width, stageSize.height, circles);
					}
				}
			}

			/* const temp = renderTexture
      renderTexture = renderTexture2
      renderTexture2 = temp

      // set the new texture
      outputSprite.texture = renderTexture
      app.renderer.render(app.stage, {
        renderTexture: renderTexture2,
        clear: false,
      }) */
		});
	}
	function drawLines(left: Graphics, right: Graphics) {
		left.clear();
		right.clear();
		right.x = innerWidth;
		const hue = currentTrack?.hue ?? 150;
		const barHeight = innerHeight / (store.bars / 2);
		const barWidth = innerWidth / 1.5;
		const lineHeight = 1;
		for (let i = 0; i < bufferLength; i++) {
			const h = dataArray?.[i] ?? 0;
			const pct = h / 255;
			const vPct = i / bufferLength;
			const color = `hsl(${Math.round(vPct * hue + hue)}, ${Math.round(vPct * 60 + 40)}%, ${Math.round(vPct * 60 + 25)}%)`;
			const offsetY = Math.round((barHeight - lineHeight) / 2);
			let y = Math.round(i * barHeight);
			const w = barWidth * pct;
			left.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color });
			left.circle(w, y, 3).fill({ color, alpha: pct });
			y += offsetY;
			right.moveTo(0, y).lineTo(w, y).stroke({ width: lineHeight, color, alpha: pct });
			right.circle(w, y, 3).fill({ color, alpha: pct });
		}
	}

	function createCircle(pct: number, width: number, height: number, container: Container) {
		const g = new Graphics();
		const hue = currentTrack?.hue ?? 150;
		const color = `hsl(${Math.round(Math.random() * hue * 1.2 + hue)}, ${Math.round((1 - Math.random()) * 60 + 40)}%, ${Math.round(Math.random() * 30 + 20)}%)`;
		const radius = Math.random() * (isMobile ? 60 : 150) + 5;

		// Draw outer glow ring
		const glowRadius = radius * 1.4;
		g.circle(0, 0, glowRadius).fill({ color, alpha: 0.15 });

		// Draw middle glow ring
		const midGlowRadius = radius * 1.15;
		g.circle(0, 0, midGlowRadius).fill({ color, alpha: 0.3 });

		// Draw main circle
		if (Math.random() < 0.2) {
			g.circle(0, 0, radius).fill(color);
		} else {
			g.circle(0, 0, radius).stroke({ width: Math.random() * 2 + 1, color });
		}

		const offsetX = isMobile ? 200 : window.innerWidth * 0.7;
		g.x = Math.random() * offsetX - offsetX * 0.5 + width / 2;
		g.y = window.innerHeight + (Math.random() * 400 - 200);
		g.alpha = Math.random() * 0.3 + 0.6;
		g.blendMode = 'add-npm';

		container.addChild(g);
		gsap.to(g, {
			alpha: 0,
			duration: 3,
			x: window.innerWidth / 2,
			ease: 'quad.in',
			onComplete: () => {
				container.removeChild(g);
			}
		});
		gsap.to(g, {
			alpha: 0,
			duration: 3,
			y: g.y + -0.8 * window.innerHeight,
			ease: 'quart.in'
		});
		gsap.from(g.scale, {
			x: 0.65,
			y: 0.65,
			duration: 3,
			ease: 'expo.out'
		});
		return g;
	}

	onMount(() => {
		setTimeout(() => {
			initGraphics();
		}, 100);
	});

	function play() {
		if (music) {
			music.play();
			music.volume = 1;

			if (audioSource && store.audioContext && store.analyser) {
				audioSource.connect(store.analyser);
				store.analyser.connect(store.audioContext.destination);

				bufferLength = store.analyser.frequencyBinCount;
				dataArray = new Uint8Array(bufferLength);
			}
		} else {
			console.log('no music');
		}
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
</script>

<svelte:window bind:innerWidth bind:innerHeight />

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
<canvas bind:this={canvasEl} width="100%" height="100%"></canvas>

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
	/* h3 {
		font-size: 1rem;
		font-weight: normal;
		margin: 0 0 60px;
		opacity: 0.75;
	} */
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
		/* h3 {
			font-size: 1.25rem;
		} */
	}
	@media (min-width: 900px) {
		h1 {
			font-size: 10rem;
		}
		h2 {
			transform: translate(-5px, -50%);
		}
	}

	canvas {
		position: fixed;
		height: 100vh;
		width: 100%;
		top: 0;
		left: 0;
		z-index: 0;
	}
</style>
