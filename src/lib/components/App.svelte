<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import { store } from '$lib/store.svelte';
	import { tracks } from '$lib/tracks';
	import type { Track, TrackAudio } from '$lib/types';
	import { onDestroy, onMount } from 'svelte';
	import {
		AdditiveBlending,
		BufferAttribute,
		BufferGeometry,
		Fog,
		Group,
		Line,
		LineBasicMaterial,
		MathUtils,
		Mesh,
		MeshBasicMaterial,
		PerspectiveCamera,
		Scene,
		SphereGeometry,
		WebGLRenderer
	} from 'three';
	import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
	import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

	interface Props {
		currentTrack?: Track | null;
	}

	interface LineNode {
		depthT: number;
		core: Line;
		ghost: Line;
		corePosition: Float32Array;
		ghostPosition: Float32Array;
		coreMaterial: LineBasicMaterial;
		ghostMaterial: LineBasicMaterial;
	}

	interface SphereParticle {
		mesh: Mesh;
		material: MeshBasicMaterial;
		velocityY: number;
		velocityZ: number;
		life: number;
		maxLife: number;
		active: boolean;
	}

	let { currentTrack = $bindable(null) }: Props = $props();

	let music = $state<HTMLAudioElement | null>(null);
	let audioSource = $state<MediaElementAudioSourceNode | null>(null);
	let bufferLength = $state(0);
	let dataArray = $state<Uint8Array<ArrayBuffer> | null>(null);
	let ghostArray = $state<Float32Array | null>(null);
	let canvasEl = $state<HTMLCanvasElement>();
	let innerWidth = $state(typeof window === 'undefined' ? 393 : window.innerWidth);
	let innerHeight = $state(typeof window === 'undefined' ? 660 : window.innerHeight);

	let renderer: WebGLRenderer | null = null;
	let scene: Scene | null = null;
	let camera: PerspectiveCamera | null = null;
	let composer: EffectComposer | null = null;
	let bokehPass: BokehPass | null = null;
	let groundGroup: Group | null = null;
	let sphereGeometry: SphereGeometry | null = null;
	let lines: LineNode[] = [];
	let particles: SphereParticle[] = [];
	let animationFrameId = 0;
	let previousFrameTime = 0;
	let hasConnectedAnalyserOutput = false;

	const lineGhostDecayDesktop = 0.992;
	const lineGhostDecayMobile = 0.988;
	const maxParticlesDesktop = 100;
	const maxParticlesMobile = 55;
	const lineCountFallback = store.bars / 2;

	let isMobile = $derived(innerWidth < 560);

	function getPixelRatio() {
		const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
		return Math.min(isMobile ? 1.1 : 1.4, dpr);
	}

	function getCanvasSize() {
		const main = document.querySelector('main');
		return {
			width: Math.max(1, Math.round(main?.clientWidth ?? window.innerWidth)),
			height: Math.max(1, Math.round(main?.clientHeight ?? window.innerHeight))
		};
	}

	function setupGroundLines() {
		if (!groundGroup) return;

		for (const line of lines) {
			line.core.geometry.dispose();
			line.ghost.geometry.dispose();
			line.coreMaterial.dispose();
			line.ghostMaterial.dispose();
		}
		lines = [];
		groundGroup.clear();

		const count = Math.max(24, bufferLength || lineCountFallback);
		if (!ghostArray || ghostArray.length !== count) {
			ghostArray = new Float32Array(count);
		}

		for (let i = 0; i < count; i++) {
			const depthT = count <= 1 ? 0 : i / (count - 1);
			const z = MathUtils.lerp(6, -90, depthT);
			const y = MathUtils.lerp(-7.8, 2.6, depthT);

			const corePosition = new Float32Array([-0.1, y, z, 0.1, y, z]);
			const ghostPosition = new Float32Array([-0.1, y, z, 0.1, y, z]);

			const coreGeometry = new BufferGeometry();
			coreGeometry.setAttribute('position', new BufferAttribute(corePosition, 3));

			const ghostGeometry = new BufferGeometry();
			ghostGeometry.setAttribute('position', new BufferAttribute(ghostPosition, 3));

			const coreMaterial = new LineBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.9
			});

			const ghostMaterial = new LineBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.25,
				blending: AdditiveBlending,
				depthWrite: false
			});

			const ghost = new Line(ghostGeometry, ghostMaterial);
			const core = new Line(coreGeometry, coreMaterial);

			groundGroup.add(ghost);
			groundGroup.add(core);

			lines.push({
				depthT,
				core,
				ghost,
				corePosition,
				ghostPosition,
				coreMaterial,
				ghostMaterial
			});
		}
	}

	function setupSpherePool() {
		if (!scene) return;

		for (const particle of particles) {
			scene.remove(particle.mesh);
			particle.material.dispose();
		}
		particles = [];

		sphereGeometry?.dispose();
		sphereGeometry = new SphereGeometry(isMobile ? 0.34 : 0.5, 18, 12);

		const count = isMobile ? maxParticlesMobile : maxParticlesDesktop;
		for (let i = 0; i < count; i++) {
			const material = new MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0,
				blending: AdditiveBlending,
				depthWrite: false
			});
			const mesh = new Mesh(sphereGeometry, material);
			mesh.visible = false;
			scene.add(mesh);
			particles.push({
				mesh,
				material,
				velocityY: 0,
				velocityZ: 0,
				life: 0,
				maxLife: 0,
				active: false
			});
		}
	}

	function onResize() {
		if (!renderer || !camera) return;
		const { width, height } = getCanvasSize();
		renderer.setPixelRatio(getPixelRatio());
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		camera.updateProjectionMatrix();
		composer?.setSize(width, height);
	}

	function initThree() {
		if (!canvasEl) return;

		const { width, height } = getCanvasSize();
		renderer = new WebGLRenderer({
			canvas: canvasEl,
			antialias: true,
			alpha: false,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(getPixelRatio());
		renderer.setSize(width, height, false);
		renderer.setClearColor('#040612', 1);

		scene = new Scene();
		scene.fog = new Fog('#040612', 18, 120);

		camera = new PerspectiveCamera(44, width / height, 0.1, 220);
		camera.position.set(0, 8.5, 18);
		camera.lookAt(0, -2, -55);

		groundGroup = new Group();
		scene.add(groundGroup);

		setupGroundLines();
		setupSpherePool();

		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		bokehPass = new BokehPass(scene, camera, {
			focus: isMobile ? 17 : 20,
			aperture: isMobile ? 0.00012 : 0.0002,
			maxblur: isMobile ? 0.004 : 0.006
		});
		composer.addPass(bokehPass);

		window.addEventListener('resize', onResize);
	}

	function activateParticle(intensity: number) {
		const particle = particles.find((entry) => !entry.active);
		if (!particle) return;

		const hueBase = currentTrack?.hue ?? 260;
		const hue = ((hueBase + Math.random() * 90) % 360) / 360;
		particle.material.color.setHSL(hue, 0.85, 0.62);
		particle.material.opacity = 0.35 + Math.random() * 0.45;

		particle.mesh.position.set(
			(Math.random() - 0.5) * (isMobile ? 6 : 10),
			-8.6 + Math.random() * 1.6,
			6 + Math.random() * 3
		);
		const scale = MathUtils.lerp(0.4, isMobile ? 1.1 : 1.5, Math.random());
		particle.mesh.scale.setScalar(scale);

		particle.velocityZ = -(9 + Math.random() * (10 + intensity * 12));
		particle.velocityY = 0.45 + Math.random() * 1.6;
		particle.life = 0;
		particle.maxLife = 2.8 + Math.random() * 2;
		particle.active = true;
		particle.mesh.visible = true;
	}

	function updateParticles(delta: number, intensity: number) {
		let peakSpawn = 0;
		if (intensity > 0.65 && Math.random() < 0.45) peakSpawn += 1;
		if (intensity > 0.82 && Math.random() < 0.7) peakSpawn += isMobile ? 1 : 2;
		if (Math.random() < intensity * 0.08) peakSpawn += 1;

		for (let i = 0; i < peakSpawn; i++) {
			activateParticle(intensity);
		}

		for (const particle of particles) {
			if (!particle.active) continue;

			particle.life += delta;
			if (particle.life >= particle.maxLife || particle.mesh.position.z < -120) {
				particle.active = false;
				particle.mesh.visible = false;
				continue;
			}

			particle.mesh.position.z += particle.velocityZ * delta;
			particle.mesh.position.y += particle.velocityY * delta;
			particle.mesh.position.x += Math.sin(particle.life * 1.7 + particle.velocityY) * delta * 0.35;

			const lifeT = particle.life / particle.maxLife;
			particle.material.opacity *= 0.985;
			particle.material.opacity = Math.max(0, particle.material.opacity * (1 - lifeT * 0.05));
			particle.mesh.scale.multiplyScalar(1 + delta * 0.07);
		}
	}

	function updateGroundLines() {
		if (!dataArray || !lines.length) return;

		const hueBase = currentTrack?.hue ?? 260;
		const decay = isMobile ? lineGhostDecayMobile : lineGhostDecayDesktop;
		const freqStep = Math.max(1, Math.floor(dataArray.length / lines.length));

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const sampleIndex = Math.min(dataArray.length - 1, i * freqStep);
			const pct = dataArray[sampleIndex] / 255;
			const previousGhost = ghostArray?.[i] ?? 0;
			const ghostPct = Math.max(pct, previousGhost * decay);
			if (ghostArray) ghostArray[i] = ghostPct;
			const ghostCurve = ghostPct * ghostPct * ghostPct;

			const nearWeight = 1 - line.depthT;
			const baseHalf = MathUtils.lerp(4.5, 23, nearWeight);
			const coreHalfWidth = baseHalf * (0.7 + pct * 1.4);
			const ghostHalfWidth = baseHalf * (0.95 + ghostCurve * 2.2);

			line.corePosition[0] = -coreHalfWidth;
			line.corePosition[3] = coreHalfWidth;
			line.ghostPosition[0] = -ghostHalfWidth;
			line.ghostPosition[3] = ghostHalfWidth;

			const coreAttr = line.core.geometry.getAttribute('position') as BufferAttribute;
			const ghostAttr = line.ghost.geometry.getAttribute('position') as BufferAttribute;
			coreAttr.needsUpdate = true;
			ghostAttr.needsUpdate = true;

			const hue = (((hueBase + line.depthT * 120) % 360) + 360) % 360;
			const sat = MathUtils.lerp(0.92, 0.52, line.depthT);
			const lit = MathUtils.lerp(0.68, 0.28, line.depthT);
			line.coreMaterial.color.setHSL(hue / 360, sat, lit);
			line.ghostMaterial.color.setHSL(hue / 360, sat, Math.min(0.82, lit + 0.12));

			line.coreMaterial.opacity = MathUtils.lerp(0.95, 0.32, line.depthT) * (0.4 + pct * 0.9);
			line.ghostMaterial.opacity =
				MathUtils.lerp(0.36, 0.06, line.depthT) * (0.3 + ghostCurve * 1.7);
		}
	}

	function animateFrame(now: number) {
		const delta = previousFrameTime ? Math.min(0.05, (now - previousFrameTime) / 1000) : 0.016;
		previousFrameTime = now;

		if (store.analyser && dataArray) {
			store.analyser.getByteFrequencyData(dataArray);
			updateGroundLines();

			let sum = 0;
			for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
			const intensity = dataArray.length ? sum / (255 * dataArray.length) : 0;
			updateParticles(delta, intensity);
		} else {
			updateParticles(delta, 0);
		}

		if (composer) {
			composer.render(delta);
		} else if (renderer && scene && camera) {
			renderer.render(scene, camera);
		}

		animationFrameId = requestAnimationFrame(animateFrame);
	}

	function cleanupThree() {
		cancelAnimationFrame(animationFrameId);
		window.removeEventListener('resize', onResize);

		for (const line of lines) {
			line.core.geometry.dispose();
			line.ghost.geometry.dispose();
			line.coreMaterial.dispose();
			line.ghostMaterial.dispose();
		}
		lines = [];

		for (const particle of particles) {
			particle.material.dispose();
		}
		particles = [];

		sphereGeometry?.dispose();
		sphereGeometry = null;

		composer?.dispose();
		composer = null;
		bokehPass = null;

		scene?.clear();
		scene = null;
		camera = null;

		renderer?.dispose();
		renderer = null;
	}

	onMount(() => {
		initThree();
		animationFrameId = requestAnimationFrame(animateFrame);
	});

	onDestroy(() => {
		cleanupThree();
	});

	function play() {
		if (!music) {
			console.log('no music');
			return;
		}

		music.play();
		music.volume = 1;

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

			const nextBufferLength = store.analyser.frequencyBinCount;
			const needsRebuild = nextBufferLength !== bufferLength;
			bufferLength = nextBufferLength;
			dataArray = new Uint8Array(bufferLength);
			ghostArray = new Float32Array(bufferLength);

			if (needsRebuild) {
				setupGroundLines();
			}
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
