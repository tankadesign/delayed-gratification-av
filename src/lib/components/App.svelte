<script lang="ts">
	import TrackComponent from '$lib/components/Track.svelte';
	import { evaluateBeatBand, resolveEffectiveBpm } from '$lib/beat-detector';
	import { store } from '$lib/store.svelte';
	import { defaultBeatConfig, tracks } from '$lib/tracks';
	import type { BeatConfig, Track, TrackAudio } from '$lib/types';
	import { onDestroy, onMount } from 'svelte';
	import {
		AdditiveBlending,
		CylinderGeometry,
		Fog,
		Group,
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
		baseY: number;
		group: Group;
		shell: Mesh;
		core: Mesh;
		tipLeft: Mesh;
		tipRight: Mesh;
		shellMaterial: MeshBasicMaterial;
		coreMaterial: MeshBasicMaterial;
		tipMaterial: MeshBasicMaterial;
	}

	interface SphereParticle {
		mesh: Mesh;
		material: MeshBasicMaterial;
		isLarge: boolean;
		targetOpacity: number;
		baseScale: number;
		velocityX: number;
		velocityY: number;
		velocityZ: number;
		accelerationX: number;
		accelerationY: number;
		accelerationZ: number;
		growDuration: number;
		life: number;
		maxLife: number;
		active: boolean;
	}

	interface SceneEnergy {
		bass: number;
		mid: number;
		high: number;
		presence800to2k: number;
		intensity: number;
		transient: number;
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
	let particleGroup: Group | null = null;
	let lineShellGeometry: CylinderGeometry | null = null;
	let lineCoreGeometry: CylinderGeometry | null = null;
	let lineTipGeometry: SphereGeometry | null = null;
	let sphereGeometry: SphereGeometry | null = null;
	let sphereGeometryLarge: SphereGeometry | null = null;
	let lines: LineNode[] = [];
	let particles: SphereParticle[] = [];
	let animationFrameId = 0;
	let previousFrameTime = 0;
	let hasConnectedAnalyserOutput = false;
	let smoothedBass = 0;
	let smoothedMid = 0;
	let smoothedHigh = 0;
	let smoothedTransient = 0;
	let downbeatAverage = 0;
	let accentAverage = 0;
	let downbeatCutoff = $state(0);
	let accentCutoff = 0;
	let lastDownbeatHitTime = 0;
	let lastAccentHitTime = 0;
	let estimatedBpm = 0;
	let scenePulse = 0;
	let showTuningPanel = $state(true);
	let activeBeatConfig = $state<BeatConfig>({ ...defaultBeatConfig });
	let debugDownbeatDetected = $state(false);
	let debugAccentDetected = $state(false);
	let debugDownbeatEnergy = $state(0);
	let debugAccentEnergy = $state(0);
	let debugLargeSpawn = $state(0);
	let debugSmallSpawn = $state(0);
	let debugBpm = $state(0);
	let beatConfigExport = $state('');

	const lineGhostDecayDesktop = 0.992;
	const lineGhostDecayMobile = 0.988;
	// Particle pool size (upper bound of concurrently active particles). Increase if bursts hit a ceiling.
	const maxParticlesDesktop = 500;
	const maxParticlesMobile = 55;
	const lineCountDesktop = 60;
	const lineCountMobile = 26;
	const localBeatConfigPrefix = 'delayed-gratification-av:v2:beat-config:';
	const downbeatCutoffDecayPerSecond = 1.7;
	const accentCutoffDecayPerSecond = 2.4;

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

	function getViewportWidthAtZ(worldZ: number) {
		if (!camera) return isMobile ? 8 : 14;
		const verticalFov = MathUtils.degToRad(camera.fov);
		const depth = Math.abs(camera.position.z - worldZ);
		const worldHeight = 2 * Math.tan(verticalFov / 2) * depth;
		return worldHeight * camera.aspect * 6.5;
	}

	function averageRange(startRatio: number, endRatio: number) {
		if (!dataArray?.length) return 0;
		const start = Math.max(0, Math.floor(dataArray.length * startRatio));
		const end = Math.max(start + 1, Math.floor(dataArray.length * endRatio));
		let total = 0;
		let count = 0;
		for (let i = start; i < end && i < dataArray.length; i++) {
			total += dataArray[i];
			count += 1;
		}
		return count ? total / (count * 255) : 0;
	}

	function averageFrequencyBand(startHz: number, endHz: number) {
		if (!dataArray?.length) return 0;
		const sampleRate = store.audioContext?.sampleRate ?? 48000;
		const nyquist = sampleRate * 0.5;
		const maxIndex = dataArray.length - 1;
		const startIndex = Math.max(
			0,
			Math.min(maxIndex, Math.floor((startHz / nyquist) * dataArray.length))
		);
		const endIndex = Math.max(
			startIndex + 1,
			Math.min(maxIndex + 1, Math.ceil((endHz / nyquist) * dataArray.length))
		);
		let total = 0;
		let count = 0;
		for (let i = startIndex; i < endIndex; i++) {
			total += dataArray[i];
			count += 1;
		}
		return count ? total / (count * 255) : 0;
	}

	function normalizeBeatConfig(config?: Partial<BeatConfig>): BeatConfig {
		return {
			...defaultBeatConfig,
			...(config ?? {})
		};
	}

	function getTrackBeatDefaults(track?: Track | null) {
		return normalizeBeatConfig(track?.beatConfig);
	}

	function getBeatConfigStorageKey(track?: Track | null) {
		return track ? `${localBeatConfigPrefix}${track.id}` : '';
	}

	function readStoredBeatConfig(track?: Track | null) {
		if (typeof localStorage === 'undefined' || !track) return null;
		const rawConfig = localStorage.getItem(getBeatConfigStorageKey(track));
		if (!rawConfig) return null;
		try {
			return normalizeBeatConfig(JSON.parse(rawConfig) as Partial<BeatConfig>);
		} catch {
			return null;
		}
	}

	function updateBeatConfigExport() {
		beatConfigExport = JSON.stringify(activeBeatConfig, null, 2);
	}

	function resetBeatDetectorState() {
		downbeatAverage = 0;
		accentAverage = 0;
		downbeatCutoff = activeBeatConfig.downbeatMinEnergy;
		accentCutoff = activeBeatConfig.accentMinEnergy;
		lastDownbeatHitTime = 0;
		lastAccentHitTime = 0;
		estimatedBpm = 0;
		debugDownbeatDetected = false;
		debugAccentDetected = false;
		debugLargeSpawn = 0;
		debugSmallSpawn = 0;
		debugBpm = 0;
	}

	function loadBeatConfigForTrack(track?: Track | null) {
		activeBeatConfig = readStoredBeatConfig(track) ?? getTrackBeatDefaults(track);
		resetBeatDetectorState();
		updateBeatConfigExport();
	}

	function saveCurrentBeatConfig() {
		if (typeof localStorage !== 'undefined' && currentTrack) {
			localStorage.setItem(getBeatConfigStorageKey(currentTrack), JSON.stringify(activeBeatConfig));
		}
		updateBeatConfigExport();
	}

	function setBeatConfigValue(key: keyof BeatConfig, value: number) {
		activeBeatConfig = {
			...activeBeatConfig,
			[key]: value
		};
		saveCurrentBeatConfig();
	}

	function resetBeatTuning() {
		activeBeatConfig = getTrackBeatDefaults(currentTrack);
		saveCurrentBeatConfig();
		resetBeatDetectorState();
	}

	function clearLocalBeatOverride() {
		if (typeof localStorage !== 'undefined' && currentTrack) {
			localStorage.removeItem(getBeatConfigStorageKey(currentTrack));
		}
		activeBeatConfig = getTrackBeatDefaults(currentTrack);
		resetBeatDetectorState();
		updateBeatConfigExport();
	}

	function isNearBpmGrid(nowSeconds: number, lastHitSeconds: number) {
		const effectiveBpm = resolveEffectiveBpm(activeBeatConfig.targetBpm, estimatedBpm);
		if (!effectiveBpm || !lastHitSeconds || activeBeatConfig.bpmLockStrength <= 0) return true;
		const beatSeconds = 60 / effectiveBpm;
		const sinceLast = nowSeconds - lastHitSeconds;
		if (sinceLast <= 0) return false;
		const nearestBeat = Math.max(1, Math.round(sinceLast / beatSeconds));
		const distance = Math.abs(sinceLast - nearestBeat * beatSeconds);
		const toleranceSeconds = beatSeconds * activeBeatConfig.bpmTimingTolerance;
		const lockAllowance = MathUtils.lerp(
			beatSeconds,
			toleranceSeconds,
			activeBeatConfig.bpmLockStrength
		);
		return distance <= lockAllowance;
	}

	function updateEstimatedBpm(nowSeconds: number) {
		if (activeBeatConfig.targetBpm > 0) {
			estimatedBpm = activeBeatConfig.targetBpm;
			debugBpm = activeBeatConfig.targetBpm;
			lastDownbeatHitTime = nowSeconds;
			return;
		}
		if (!lastDownbeatHitTime) {
			lastDownbeatHitTime = nowSeconds;
			return;
		}
		const interval = nowSeconds - lastDownbeatHitTime;
		lastDownbeatHitTime = nowSeconds;
		if (interval <= 0) return;
		const candidateBpm = 60 / interval;
		if (candidateBpm < activeBeatConfig.bpmMin || candidateBpm > activeBeatConfig.bpmMax) return;
		estimatedBpm = estimatedBpm ? MathUtils.lerp(estimatedBpm, candidateBpm, 0.28) : candidateBpm;
		debugBpm = estimatedBpm;
	}

	function readSceneEnergy(delta: number): SceneEnergy {
		const bass = averageRange(0.01, 0.12);
		const mid = averageRange(0.12, 0.36);
		const high = averageRange(0.36, 0.72);
		const presence800to2k = averageFrequencyBand(800, 2000);
		const intensity = averageRange(0.02, 0.8);

		smoothedBass = MathUtils.lerp(smoothedBass, bass, Math.min(1, delta * 10));
		smoothedMid = MathUtils.lerp(smoothedMid, mid, Math.min(1, delta * 9));
		smoothedHigh = MathUtils.lerp(smoothedHigh, high, Math.min(1, delta * 8));

		const rawTransient =
			Math.max(0, bass - smoothedBass * 0.84) + Math.max(0, mid - smoothedMid * 0.9);
		smoothedTransient = MathUtils.lerp(smoothedTransient, rawTransient, Math.min(1, delta * 16));
		scenePulse = Math.max(scenePulse * Math.pow(0.18, delta), smoothedTransient * 3.6);

		return {
			bass,
			mid,
			high,
			presence800to2k,
			intensity,
			transient: Math.min(1, smoothedTransient * 2.8)
		};
	}

	function setupGroundLines() {
		if (!groundGroup) return;

		for (const line of lines) {
			groundGroup.remove(line.group);
			line.shellMaterial.dispose();
			line.coreMaterial.dispose();
			line.tipMaterial.dispose();
		}
		lines = [];
		groundGroup.clear();

		if (!lineShellGeometry) {
			lineShellGeometry = new CylinderGeometry(0.12, 0.12, 1, 16, 1, false);
		}
		if (!lineCoreGeometry) {
			lineCoreGeometry = new CylinderGeometry(0.035, 0.035, 1, 12, 1, false);
		}
		if (!lineTipGeometry) {
			lineTipGeometry = new SphereGeometry(0.085, 12, 10);
		}

		const targetCount = isMobile ? lineCountMobile : lineCountDesktop;
		const count = Math.max(18, Math.min(bufferLength || targetCount, targetCount));
		if (!ghostArray || ghostArray.length !== count) {
			ghostArray = new Float32Array(count);
		}

		for (let i = 0; i < count; i++) {
			const depthT = count <= 1 ? 0 : i / (count - 1);
			const z = MathUtils.lerp(6, -90, depthT);
			const y = MathUtils.lerp(-8.8, 1.8, depthT);

			const group = new Group();
			group.position.set(0, y, z);

			const shellMaterial = new MeshBasicMaterial({
				color: 0xd8ecff,
				transparent: true,
				opacity: 0.2,
				blending: AdditiveBlending,
				depthWrite: false
			});
			const coreMaterial = new MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.92,
				blending: AdditiveBlending,
				depthWrite: false
			});
			const tipMaterial = new MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 1,
				blending: AdditiveBlending,
				depthWrite: false
			});

			const shell = new Mesh(lineShellGeometry, shellMaterial);
			shell.rotation.z = Math.PI / 2;

			const core = new Mesh(lineCoreGeometry, coreMaterial);
			core.rotation.z = Math.PI / 2;

			const tipLeft = new Mesh(lineTipGeometry, tipMaterial);
			const tipRight = new Mesh(lineTipGeometry, tipMaterial);
			shell.scale.set(0.001, 0.001, 0.001);
			core.scale.set(0.001, 0.001, 0.001);
			tipLeft.scale.setScalar(0.001);
			tipRight.scale.setScalar(0.001);
			shellMaterial.opacity = 0;
			coreMaterial.opacity = 0;
			tipMaterial.opacity = 0;

			group.add(shell);
			group.add(core);
			group.add(tipLeft);
			group.add(tipRight);
			groundGroup.add(group);

			lines.push({
				depthT,
				baseY: y,
				group,
				shell,
				core,
				tipLeft,
				tipRight,
				shellMaterial,
				coreMaterial,
				tipMaterial
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
		sphereGeometryLarge?.dispose();
		sphereGeometryLarge = new SphereGeometry(isMobile ? 0.34 : 0.5, 36, 24);

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
			particleGroup.add(mesh);
			particles.push({
				mesh,
				material,
				isLarge: false,
				targetOpacity: 0,
				baseScale: 1,
				velocityX: 0,
				velocityY: 0,
				velocityZ: 0,
				accelerationX: 0,
				accelerationY: 0,
				accelerationZ: 0,
				growDuration: 0,
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
		camera.position.set(0, 7.6, 17);
		camera.lookAt(0, -3.4, -48);

		groundGroup = new Group();
		scene.add(groundGroup);

		particleGroup = new Group();
		scene.add(particleGroup);
		particleGroup.position.y = 1;

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

	function activateParticle(energy: SceneEnergy, size: 'large' | 'small') {
		const particle = particles.find((entry) => !entry.active);
		if (!particle) return;

		const hueBase = currentTrack?.hue ?? 260;
		const hue = ((hueBase - 10 + Math.random() * 135) % 360) / 360;
		particle.material.color.setHSL(hue, 0.85, 0.62);
		particle.material.opacity = 0;
		const startZ = -8.5 + Math.random() * 6;
		const spawnWidth = getViewportWidthAtZ(startZ) * 1.2;
		const startX = (Math.random() - 0.5) * spawnWidth;
		const xAccelScale = MathUtils.lerp(0.35, 0.85, Math.random());
		const yAccelScale = MathUtils.lerp(0.75, 0.85, Math.random());
		const zAccelScale = MathUtils.lerp(2, 8.0, Math.random());

		particle.mesh.position.set(startX, -4.9 + Math.random() * 0.9, startZ);
		const smallBias = Math.pow(Math.random(), 2.6);
		const mostlySmallScale = MathUtils.lerp(0.14, isMobile ? 0.8 : 1.16, smallBias);
		const spawnLarge = size === 'large';
		const largeScale = MathUtils.lerp(
			isMobile ? 1.35 : 2.1,
			isMobile ? 2.7 : 4.2,
			Math.pow(Math.random(), 0.65)
		);
		particle.isLarge = spawnLarge;
		if (sphereGeometry && sphereGeometryLarge) {
			particle.mesh.geometry = spawnLarge ? sphereGeometryLarge : sphereGeometry;
		}
		particle.baseScale = spawnLarge ? largeScale : mostlySmallScale;
		particle.mesh.scale.setScalar(0.001);

		particle.targetOpacity = 0.5 + Math.random() * 0.35 + energy.transient * 0.2;
		particle.velocityX = 0;
		particle.velocityZ = -(0.15 + Math.random() * 0.45 + energy.bass * 0.4);
		particle.velocityY = 0.05 + Math.random() * 0.14 + energy.mid * 0.2;
		particle.accelerationX =
			-Math.sign(startX || 1) * (0.08 + Math.abs(startX) * 0.04) * xAccelScale;
		particle.accelerationZ =
			-(7 + Math.random() * 10 + energy.transient * 18 + (spawnLarge ? 5 : 0)) * zAccelScale;
		particle.accelerationY =
			(0.45 + Math.random() * 0.9 + energy.mid * 1.2 + (spawnLarge ? 0.18 : 0)) * yAccelScale;
		particle.growDuration = MathUtils.lerp(0.12, 0.24, Math.random());
		particle.life = 0;
		particle.maxLife = 1.6 + Math.random() * 1.1;
		particle.active = true;
		particle.mesh.visible = true;
	}

	function updateParticles(delta: number, energy: SceneEnergy) {
		const nowSeconds = music?.currentTime ?? performance.now() / 1000;
		const downbeatEnergy = averageFrequencyBand(
			Math.min(activeBeatConfig.downbeatMinHz, activeBeatConfig.downbeatMaxHz),
			Math.max(activeBeatConfig.downbeatMinHz, activeBeatConfig.downbeatMaxHz)
		);
		const accentEnergy = averageFrequencyBand(
			Math.min(activeBeatConfig.accentMinHz, activeBeatConfig.accentMaxHz),
			Math.max(activeBeatConfig.accentMinHz, activeBeatConfig.accentMaxHz)
		);
		const averageSmoothing = Math.min(1, delta * 1.8);
		downbeatAverage = downbeatAverage
			? MathUtils.lerp(downbeatAverage, downbeatEnergy, averageSmoothing)
			: downbeatEnergy;
		accentAverage = accentAverage
			? MathUtils.lerp(accentAverage, accentEnergy, averageSmoothing)
			: accentEnergy;

		const effectiveBpm = resolveEffectiveBpm(activeBeatConfig.targetBpm, estimatedBpm);
		const downbeatIntervalSeconds = effectiveBpm
			? (60 / effectiveBpm) * 0.62
			: 60 / activeBeatConfig.bpmMax;
		const downbeatResult = evaluateBeatBand({
			energy: downbeatEnergy,
			cutoff: downbeatCutoff,
			minEnergy: activeBeatConfig.downbeatMinEnergy,
			threshold: activeBeatConfig.downbeatThreshold,
			decayPerSecond: downbeatCutoffDecayPerSecond,
			delta,
			nowSeconds,
			lastHitSeconds: lastDownbeatHitTime,
			minIntervalSeconds: downbeatIntervalSeconds
		});
		const accentResult = evaluateBeatBand({
			energy: accentEnergy,
			cutoff: accentCutoff,
			minEnergy: activeBeatConfig.accentMinEnergy,
			threshold: activeBeatConfig.accentThreshold,
			decayPerSecond: accentCutoffDecayPerSecond,
			delta,
			nowSeconds,
			lastHitSeconds: lastAccentHitTime,
			minIntervalSeconds: 0.095
		});
		downbeatCutoff = downbeatResult.cutoff;
		accentCutoff = accentResult.cutoff;
		const downbeatDetected =
			downbeatResult.detected && isNearBpmGrid(nowSeconds, lastDownbeatHitTime);
		const accentDetected = accentResult.detected && isNearBpmGrid(nowSeconds, lastDownbeatHitTime);

		let largeSpawn = 0;
		let smallSpawn = 0;
		if (downbeatDetected) {
			const downbeatStrength = Math.min(
				2.5,
				downbeatEnergy / Math.max(0.001, activeBeatConfig.downbeatMinEnergy)
			);
			const burst = isMobile
				? activeBeatConfig.downbeatBurstMobile
				: activeBeatConfig.downbeatBurstDesktop;
			const maxBurst = isMobile
				? activeBeatConfig.downbeatBurstMaxMobile
				: activeBeatConfig.downbeatBurstMaxDesktop;
			largeSpawn = Math.min(
				maxBurst,
				Math.round(burst * MathUtils.lerp(0.55, 1.35, downbeatStrength / 2.5))
			);
			updateEstimatedBpm(nowSeconds);
		}
		if (accentDetected) {
			const accentStrength = Math.min(
				2.5,
				accentEnergy / Math.max(0.001, activeBeatConfig.accentMinEnergy)
			);
			const burst = isMobile
				? activeBeatConfig.accentBurstMobile
				: activeBeatConfig.accentBurstDesktop;
			const maxBurst = isMobile
				? activeBeatConfig.accentBurstMaxMobile
				: activeBeatConfig.accentBurstMaxDesktop;
			smallSpawn = Math.min(
				maxBurst,
				Math.round(burst * MathUtils.lerp(0.45, 1.45, accentStrength / 2.5))
			);
			lastAccentHitTime = nowSeconds;
		}

		debugDownbeatDetected = downbeatDetected;
		debugAccentDetected = accentDetected;
		debugDownbeatEnergy = downbeatEnergy;
		debugAccentEnergy = accentEnergy;
		debugLargeSpawn = largeSpawn;
		debugSmallSpawn = smallSpawn;
		debugBpm = resolveEffectiveBpm(activeBeatConfig.targetBpm, estimatedBpm);

		for (let i = 0; i < largeSpawn; i++) {
			activateParticle(energy, 'large');
		}
		for (let i = 0; i < smallSpawn; i++) {
			activateParticle(energy, 'small');
		}

		for (const particle of particles) {
			if (!particle.active) continue;

			particle.life += delta;
			if (particle.life >= particle.maxLife || particle.mesh.position.z < -120) {
				particle.active = false;
				particle.mesh.visible = false;
				continue;
			}
			const lifeProgress = Math.min(1, particle.life / particle.maxLife);
			const accelRamp = Math.pow(lifeProgress, 4);

			particle.velocityX += particle.accelerationX * delta * accelRamp;
			particle.velocityZ += particle.accelerationZ * delta * accelRamp;
			particle.velocityY += particle.accelerationY * delta * 20 * accelRamp;
			particle.mesh.position.x += particle.velocityX * delta;
			particle.mesh.position.z += particle.velocityZ * delta;
			//particle.mesh.position.y += particle.velocityY * delta;

			const lifeT = particle.life / particle.maxLife;
			const growT = Math.min(1, particle.life / particle.growDuration);
			const growEase = growT >= 1 ? 1 : 1 - Math.pow(2, -10 * growT);
			const fadeOut = lifeT < 0.6 ? 1 : 1 - (lifeT - 0.6) / 0.4;
			particle.material.opacity = particle.targetOpacity * Math.max(0, fadeOut) * growEase;
			particle.mesh.scale.setScalar(
				particle.baseScale * growEase * MathUtils.lerp(1.08, 1.34, lifeT)
			);
		}
	}

	function updateGroundLines(energy: SceneEnergy, time: number) {
		if (!dataArray || !lines.length) return;

		const hueBase = currentTrack?.hue ?? 260;
		const decay = isMobile ? lineGhostDecayMobile : lineGhostDecayDesktop;
		const freqStep = Math.max(1, Math.floor(dataArray.length / lines.length));

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const bandIndex = lines.length - 1 - i;
			const sampleStart = bandIndex * freqStep;
			let sampleTotal = 0;
			let sampleCount = 0;
			let samplePeak = 0;
			for (let j = 0; j < freqStep && sampleStart + j < dataArray.length; j++) {
				const sample = dataArray[sampleStart + j];
				sampleTotal += sample;
				samplePeak = Math.max(samplePeak, sample);
				sampleCount += 1;
			}
			const avgPct = sampleCount ? sampleTotal / (sampleCount * 255) : 0;
			const peakPct = samplePeak / 255;
			const pct = Math.min(1, avgPct * 0.4 + peakPct * 0.95);
			const previousGhost = ghostArray?.[i] ?? 0;
			const ghostPct = Math.max(pct, previousGhost * decay);
			if (ghostArray) ghostArray[i] = ghostPct;
			const reactivePct = Math.pow(Math.max(0, pct - 0.015) / 0.985, 0.58);
			const ghostCurve = ghostPct * ghostPct * ghostPct;

			const nearWeight = 1 - line.depthT;
			const pulse = scenePulse * Math.pow(nearWeight, 1.3);
			const shimmer = Math.sin(time * 0.005 + line.depthT * 8) * 0.5 + 0.5;
			const widthDrive = Math.min(1, reactivePct * 1.05);
			const activity = Math.min(1, widthDrive * 1.1 + ghostCurve * 0.9 + pulse * 0.35);
			const viewportWidthAtLine = getViewportWidthAtZ(line.group.position.z);
			const baseHalf =
				viewportWidthAtLine * MathUtils.lerp(0.0012, 0.018, nearWeight) +
				viewportWidthAtLine * pulse * MathUtils.lerp(0.0006, 0.004, nearWeight);
			const reactiveSpan = viewportWidthAtLine * MathUtils.lerp(0.05, 0.18, nearWeight);
			const coreHalfWidth = (baseHalf + reactiveSpan * widthDrive) * activity;
			const shellHalfWidth =
				(coreHalfWidth +
					viewportWidthAtLine *
						MathUtils.lerp(0.0018, 0.0095, nearWeight) *
						(ghostCurve + pulse * 0.12)) *
				activity;
			const yLift = pulse * MathUtils.lerp(0.01, 0.08, nearWeight);
			const shellRadius =
				(viewportWidthAtLine * MathUtils.lerp(0.00022, 0.00078, nearWeight) +
					MathUtils.lerp(0.005, 0.012, nearWeight)) *
				activity;
			const coreRadius = shellRadius * 0.18;

			line.group.position.y = line.baseY + yLift;
			line.shell.scale.set(
				Math.max(0.001, shellRadius / 0.12),
				Math.max(0.001, shellHalfWidth),
				Math.max(0.001, shellRadius / 0.12)
			);
			line.core.scale.set(
				Math.max(0.001, coreRadius / 0.035),
				Math.max(0.001, coreHalfWidth),
				Math.max(0.001, coreRadius / 0.035)
			);
			const coreHalfLength = coreHalfWidth * 0.5;
			const tipScale = (MathUtils.lerp(0.42, 0.88, nearWeight) + reactivePct * 0.35) * activity;
			line.tipRight.position.set(coreHalfLength - coreRadius * 0.15, 0, 0);
			line.tipRight.scale.setScalar(Math.max(0.001, tipScale));
			line.tipLeft.position.set(-coreHalfLength + coreRadius * 0.15, 0, 0);
			line.tipLeft.scale.setScalar(Math.max(0.001, tipScale));

			const gradientT = 1 - line.depthT;
			const gradientHue = (((hueBase - 42 + gradientT * 150 + pulse * 35) % 360) + 360) % 360;
			const sat = MathUtils.lerp(1, 0.72, line.depthT);
			const lit = MathUtils.lerp(0.24, 0.92, Math.min(1, reactivePct * 0.7 + pulse * 0.8));
			const depthLit = MathUtils.lerp(lit, lit * 0.34, line.depthT * 0.8);
			line.shellMaterial.color.setHSL(
				((gradientHue + 8) % 360) / 360,
				Math.min(0.82, sat * 0.4),
				Math.min(0.92, depthLit + 0.26)
			);
			line.coreMaterial.color.setHSL(gradientHue / 360, sat, depthLit);
			line.tipMaterial.color.setHSL(
				((gradientHue + 18 + shimmer * 12) % 360) / 360,
				Math.min(1, sat * 0.98),
				Math.min(0.95, depthLit + 0.24 + pulse * 0.14)
			);

			line.shellMaterial.opacity = Math.min(
				0.42,
				MathUtils.lerp(0.18, 0.06, line.depthT) *
					MathUtils.lerp(0.55, 1, ghostCurve + pulse * 0.22) *
					activity
			);
			line.coreMaterial.opacity = Math.min(
				1,
				MathUtils.lerp(1.2, 0.34, line.depthT) * MathUtils.lerp(0.22, 1.15, widthDrive) * activity
			);
			line.tipMaterial.opacity = Math.min(
				1,
				MathUtils.lerp(0.88, 0.16, line.depthT) *
					MathUtils.lerp(0.4, 1.35, widthDrive + ghostCurve * 0.35) *
					activity
			);
		}
	}

	function animateFrame(now: number) {
		const delta = previousFrameTime ? Math.min(0.05, (now - previousFrameTime) / 1000) : 0.016;
		previousFrameTime = now;

		if (store.analyser && dataArray) {
			store.analyser.getByteFrequencyData(dataArray);
			const energy = readSceneEnergy(delta);
			updateGroundLines(energy, now);
			updateParticles(delta, energy);
		} else {
			updateParticles(delta, {
				bass: 0,
				mid: 0,
				high: 0,
				presence800to2k: 0,
				intensity: 0,
				transient: 0
			});
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
			line.shellMaterial.dispose();
			line.coreMaterial.dispose();
			line.tipMaterial.dispose();
		}
		lines = [];

		lineShellGeometry?.dispose();
		lineShellGeometry = null;
		lineCoreGeometry?.dispose();
		lineCoreGeometry = null;
		lineTipGeometry?.dispose();
		lineTipGeometry = null;

		for (const particle of particles) {
			particle.material.dispose();
		}
		particles = [];

		sphereGeometry?.dispose();
		sphereGeometry = null;
		sphereGeometryLarge?.dispose();
		sphereGeometryLarge = null;

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
		loadBeatConfigForTrack(currentTrack);
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
		loadBeatConfigForTrack(track);
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
	<div class="beat-debug" aria-hidden="true">
		<div class="beat-debug-title">Beat Detector</div>
		<div class="beat-debug-row">
			<span>Track</span>
			<span>{currentTrack?.name ?? 'none'}</span>
		</div>
		<div class="beat-debug-row">
			<span>Downbeat</span>
			<span>{debugDownbeatDetected ? 'hit' : debugDownbeatEnergy.toFixed(3)}</span>
		</div>
		<div class="beat-debug-row">
			<span>Accent</span>
			<span>{debugAccentDetected ? 'hit' : debugAccentEnergy.toFixed(3)}</span>
		</div>
		<div class="beat-debug-row">
			<span>Spawn L / S</span>
			<span>{debugLargeSpawn} / {debugSmallSpawn}</span>
		</div>
		<div class="beat-debug-row">
			<span>BPM</span>
			<span>{debugBpm ? debugBpm.toFixed(1) : '-'}</span>
		</div>
		<div class="beat-meter">
			<div
				class="beat-meter-fill"
				style={`width: ${Math.min(100, debugDownbeatEnergy * 100)}%`}
			></div>
			<div
				class="beat-meter-threshold"
				style={`left: ${Math.min(100, downbeatCutoff * 100)}%`}
			></div>
		</div>
	</div>
	<div class="tuning-wrap">
		<button
			class="tuning-toggle"
			type="button"
			onclick={() => {
				showTuningPanel = !showTuningPanel;
			}}
		>
			{showTuningPanel ? 'Hide tune' : 'Tune'}
		</button>
		{#if showTuningPanel}
			<div class="tuning-panel">
				<div class="tuning-header">
					<span>{currentTrack?.id ?? 'Beat'} Config</span>
					<button class="tuning-reset" type="button" onclick={resetBeatTuning}>Reset</button>
				</div>
				<div class="tuning-grid">
					<label class="tuning-control">
						<span>Down Hz Min {activeBeatConfig.downbeatMinHz}</span>
						<input
							type="range"
							min="20"
							max="420"
							step="1"
							value={activeBeatConfig.downbeatMinHz}
							oninput={(e) => setBeatConfigValue('downbeatMinHz', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Down Hz Max {activeBeatConfig.downbeatMaxHz}</span>
						<input
							type="range"
							min="40"
							max="1200"
							step="1"
							value={activeBeatConfig.downbeatMaxHz}
							oninput={(e) => setBeatConfigValue('downbeatMaxHz', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Down Threshold {activeBeatConfig.downbeatThreshold.toFixed(2)}</span>
						<input
							type="range"
							min="1.05"
							max="4"
							step="0.01"
							value={activeBeatConfig.downbeatThreshold}
							oninput={(e) =>
								setBeatConfigValue('downbeatThreshold', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Down Gate {activeBeatConfig.downbeatMinEnergy.toFixed(3)}</span>
						<input
							type="range"
							min="0.005"
							max="0.6"
							step="0.001"
							value={activeBeatConfig.downbeatMinEnergy}
							oninput={(e) =>
								setBeatConfigValue('downbeatMinEnergy', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Large Burst D {activeBeatConfig.downbeatBurstDesktop}</span>
						<input
							type="range"
							min="0"
							max="360"
							step="1"
							value={activeBeatConfig.downbeatBurstDesktop}
							oninput={(e) =>
								setBeatConfigValue('downbeatBurstDesktop', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Large Burst M {activeBeatConfig.downbeatBurstMobile}</span>
						<input
							type="range"
							min="0"
							max="120"
							step="1"
							value={activeBeatConfig.downbeatBurstMobile}
							oninput={(e) =>
								setBeatConfigValue('downbeatBurstMobile', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Large Cap D {activeBeatConfig.downbeatBurstMaxDesktop}</span>
						<input
							type="range"
							min="10"
							max="500"
							step="1"
							value={activeBeatConfig.downbeatBurstMaxDesktop}
							oninput={(e) =>
								setBeatConfigValue('downbeatBurstMaxDesktop', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Large Cap M {activeBeatConfig.downbeatBurstMaxMobile}</span>
						<input
							type="range"
							min="8"
							max="160"
							step="1"
							value={activeBeatConfig.downbeatBurstMaxMobile}
							oninput={(e) =>
								setBeatConfigValue('downbeatBurstMaxMobile', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Accent Hz Min {activeBeatConfig.accentMinHz}</span>
						<input
							type="range"
							min="80"
							max="4000"
							step="1"
							value={activeBeatConfig.accentMinHz}
							oninput={(e) => setBeatConfigValue('accentMinHz', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Accent Hz Max {activeBeatConfig.accentMaxHz}</span>
						<input
							type="range"
							min="120"
							max="9000"
							step="1"
							value={activeBeatConfig.accentMaxHz}
							oninput={(e) => setBeatConfigValue('accentMaxHz', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Accent Threshold {activeBeatConfig.accentThreshold.toFixed(2)}</span>
						<input
							type="range"
							min="1.05"
							max="4"
							step="0.01"
							value={activeBeatConfig.accentThreshold}
							oninput={(e) => setBeatConfigValue('accentThreshold', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Accent Gate {activeBeatConfig.accentMinEnergy.toFixed(3)}</span>
						<input
							type="range"
							min="0.005"
							max="0.6"
							step="0.001"
							value={activeBeatConfig.accentMinEnergy}
							oninput={(e) => setBeatConfigValue('accentMinEnergy', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Small Burst D {activeBeatConfig.accentBurstDesktop}</span>
						<input
							type="range"
							min="0"
							max="320"
							step="1"
							value={activeBeatConfig.accentBurstDesktop}
							oninput={(e) =>
								setBeatConfigValue('accentBurstDesktop', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Small Burst M {activeBeatConfig.accentBurstMobile}</span>
						<input
							type="range"
							min="0"
							max="100"
							step="1"
							value={activeBeatConfig.accentBurstMobile}
							oninput={(e) =>
								setBeatConfigValue('accentBurstMobile', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Small Cap D {activeBeatConfig.accentBurstMaxDesktop}</span>
						<input
							type="range"
							min="10"
							max="420"
							step="1"
							value={activeBeatConfig.accentBurstMaxDesktop}
							oninput={(e) =>
								setBeatConfigValue('accentBurstMaxDesktop', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Small Cap M {activeBeatConfig.accentBurstMaxMobile}</span>
						<input
							type="range"
							min="8"
							max="140"
							step="1"
							value={activeBeatConfig.accentBurstMaxMobile}
							oninput={(e) =>
								setBeatConfigValue('accentBurstMaxMobile', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>BPM Min {activeBeatConfig.bpmMin}</span>
						<input
							type="range"
							min="40"
							max="140"
							step="1"
							value={activeBeatConfig.bpmMin}
							oninput={(e) => setBeatConfigValue('bpmMin', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>BPM Max {activeBeatConfig.bpmMax}</span>
						<input
							type="range"
							min="120"
							max="260"
							step="1"
							value={activeBeatConfig.bpmMax}
							oninput={(e) => setBeatConfigValue('bpmMax', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>Target BPM {activeBeatConfig.targetBpm || 'auto'}</span>
						<input
							type="range"
							min="0"
							max="220"
							step="1"
							value={activeBeatConfig.targetBpm}
							oninput={(e) => setBeatConfigValue('targetBpm', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>BPM Tolerance {activeBeatConfig.bpmTimingTolerance.toFixed(2)}</span>
						<input
							type="range"
							min="0"
							max="0.5"
							step="0.01"
							value={activeBeatConfig.bpmTimingTolerance}
							oninput={(e) =>
								setBeatConfigValue('bpmTimingTolerance', Number(e.currentTarget.value))}
						/>
					</label>
					<label class="tuning-control">
						<span>BPM Lock {activeBeatConfig.bpmLockStrength.toFixed(2)}</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.01"
							value={activeBeatConfig.bpmLockStrength}
							oninput={(e) => setBeatConfigValue('bpmLockStrength', Number(e.currentTarget.value))}
						/>
					</label>
				</div>
				<div class="tuning-actions">
					<button class="tuning-reset" type="button" onclick={clearLocalBeatOverride}
						>Clear Local</button
					>
				</div>
				<label class="tuning-control export-control">
					<span>Copy to tracks.ts</span>
					<textarea readonly value={beatConfigExport}></textarea>
				</label>
			</div>
		{/if}
	</div>
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
	.beat-debug {
		position: fixed;
		top: 14px;
		left: 14px;
		z-index: 3;
		width: 220px;
		padding: 10px 12px;
		border-radius: 10px;
		background: rgba(9, 12, 22, 0.38);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.22);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
		color: rgba(255, 255, 255, 0.92);
		font-size: 11px;
		line-height: 1.3;
		letter-spacing: 0.02em;
		font-family: 'Zen Dots';
		pointer-events: none;
	}
	.beat-debug-title {
		font-size: 10px;
		margin-bottom: 8px;
		opacity: 0.8;
		text-transform: uppercase;
	}
	.beat-debug-row {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 3px;
	}
	.beat-meter {
		position: relative;
		height: 12px;
		margin-top: 8px;
		border-radius: 999px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.14);
	}
	.beat-meter-fill {
		height: 100%;
		background: linear-gradient(90deg, rgba(120, 220, 255, 0.75), rgba(255, 255, 255, 0.88));
	}
	.beat-meter-threshold {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: rgba(255, 120, 120, 0.95);
		transform: translateX(-1px);
	}
	.tuning-wrap {
		position: fixed;
		top: 14px;
		right: 14px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
	}
	.tuning-toggle {
		background: rgba(9, 12, 22, 0.58);
		border: 1px solid rgba(255, 255, 255, 0.26);
		color: rgba(255, 255, 255, 0.92);
		padding: 6px 10px;
		border-radius: 8px;
		font-size: 11px;
		line-height: 1;
		font-family: inherit;
	}
	.tuning-panel {
		width: min(280px, calc(100vw - 28px));
		max-height: min(68vh, 520px);
		overflow: auto;
		padding: 10px;
		border-radius: 10px;
		background: rgba(9, 12, 22, 0.45);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border: 1px solid rgba(255, 255, 255, 0.2);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
		color: rgba(255, 255, 255, 0.92);
		font-size: 11px;
		line-height: 1.25;
		font-family: inherit;
	}
	.tuning-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.tuning-reset {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.24);
		color: rgba(255, 255, 255, 0.92);
		padding: 3px 7px;
		border-radius: 7px;
		font-size: 10px;
		font-family: inherit;
	}
	.tuning-grid {
		display: grid;
		gap: 7px;
	}
	.tuning-control {
		display: grid;
		gap: 3px;
	}
	.tuning-control span {
		display: flex;
		justify-content: space-between;
	}
	.tuning-control input {
		width: 100%;
		accent-color: #9cdcff;
	}
	.tuning-actions {
		display: flex;
		justify-content: flex-end;
		padding-top: 2px;
	}
	.export-control textarea {
		width: 100%;
		min-height: 92px;
		resize: vertical;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 7px;
		background: rgba(0, 0, 0, 0.22);
		color: rgba(255, 255, 255, 0.82);
		font:
			10px/1.35 ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			monospace;
	}
	.tuning-toggle,
	.tuning-reset {
		cursor: pointer;
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
