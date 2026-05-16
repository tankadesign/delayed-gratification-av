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
		Color,
		CylinderGeometry,
		DynamicDrawUsage,
		Fog,
		Group,
		MathUtils,
		Mesh,
		MeshBasicMaterial,
		PerspectiveCamera,
		Points,
		Scene,
		ShaderMaterial,
		SphereGeometry,
		Vector3,
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
		spectrumT: number;
		currentHalfLength: number;
		currentColor: Color;
	}

	interface FloatParticle {
		active: boolean;
		life: number;
		maxLife: number;
		startX: number;
		startY: number;
		startZ: number;
		driftX: number;
		driftZ: number;
		lift: number;
		size: number;
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

	let bokehPass = $state<BokehPass | null>(null);

	let renderer: WebGLRenderer | null = null;
	let scene: Scene | null = null;
	let camera: PerspectiveCamera | null = null;
	let composer: EffectComposer | null = null;
	let groundGroup: Group | null = null;
	let cameraTarget = new Vector3(0, -3.4, -45);
	let cameraOrigin = $state({ x: -17, y: 1, z: 10.5 });
	let cameraTargetPosition = $state({ x: -6, y: 0, z: -15 });
	let particleLayer: Points | null = null;
	let particleGeometry: BufferGeometry | null = null;
	let particleMaterial: ShaderMaterial | null = null;
	let particlePositions: Float32Array | null = null;
	let particleColors: Float32Array | null = null;
	let particleAlphas: Float32Array | null = null;
	let particleSizes: Float32Array | null = null;
	let floatParticles: FloatParticle[] = [];
	let nextParticleIndex = 0;
	let lastParticleBeatIndex = -1;
	let lineShellGeometry: CylinderGeometry | null = null;
	let lineCoreGeometry: CylinderGeometry | null = null;
	let lineTipGeometry: SphereGeometry | null = null;
	let lines: LineNode[] = [];
	let animationFrameId = 0;
	let previousFrameTime = 0;
	let hasConnectedAnalyserOutput = false;
	let smoothedBass = 0;
	let smoothedMid = 0;
	let smoothedHigh = 0;
	let smoothedTransient = 0;
	let scenePulse = 0;
	let particleMinPerLine = $state(2);
	let particleMaxPerLine = $state(50);
	let particleEndpointBias = $state(0.92);
	let showParticleTuning = $state(true);
	let enableBokeh = $state(false);

	const lineGhostDecayDesktop = 0.992;
	const lineGhostDecayMobile = 0.988;
	const lineCountDesktop = 60;
	const lineCountMobile = 26;
	const maxFloatParticlesDesktop = 18000;
	const maxFloatParticlesMobile = 6000;
	const cameraLoopSeconds = 24;
	const cameraKeyboardStep = 0.25;

	let isMobile = $derived(innerWidth < 560);

	$effect(() => {
		if (bokehPass) {
			if (enableBokeh) {
				composer?.addPass(bokehPass);
				console.log('bokeh enabled');
			} else {
				composer?.removePass(bokehPass);
				console.log('bokeh removed');
			}
		}
	});

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
		return worldHeight * camera.aspect * 4.8;
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

	function sampleLineGradient(t: number, stops: string[], pulse: number) {
		const colorStops = stops.length
			? stops.map((stop) => new Color(stop))
			: [new Color('#ff184c'), new Color('#1887ff')];
		const scaled = MathUtils.clamp(t, 0, 1) * (colorStops.length - 1);
		const index = Math.min(colorStops.length - 2, Math.floor(scaled));
		const color = colorStops[index].clone().lerp(colorStops[index + 1], scaled - index);
		return color.lerp(new Color('#ffffff'), pulse * 0.1);
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
			const spectrumT = Math.abs(depthT * 2 - 1);
			const z = MathUtils.lerp(0, -90, depthT);
			const y = MathUtils.lerp(-7.2, 1.8, depthT);

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
				tipMaterial,
				spectrumT,
				currentHalfLength: 0,
				currentColor: new Color(0xffffff)
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
		if (particleMaterial) {
			particleMaterial.uniforms.pixelRatio.value = getPixelRatio();
		}
	}

	function setupFloatParticles() {
		if (!scene) return;

		if (particleLayer) {
			scene.remove(particleLayer);
		}
		particleGeometry?.dispose();
		particleMaterial?.dispose();

		const count = isMobile ? maxFloatParticlesMobile : maxFloatParticlesDesktop;
		particlePositions = new Float32Array(count * 3);
		particleColors = new Float32Array(count * 3);
		particleAlphas = new Float32Array(count);
		particleSizes = new Float32Array(count);
		floatParticles = Array.from({ length: count }, () => ({
			active: false,
			life: 0,
			maxLife: 0,
			startX: 0,
			startY: 0,
			startZ: 0,
			driftX: 0,
			driftZ: 0,
			lift: 0,
			size: 0
		}));

		particleGeometry = new BufferGeometry();
		const positionAttribute = new BufferAttribute(particlePositions, 3);
		const colorAttribute = new BufferAttribute(particleColors, 3);
		const alphaAttribute = new BufferAttribute(particleAlphas, 1);
		const sizeAttribute = new BufferAttribute(particleSizes, 1);
		positionAttribute.setUsage(DynamicDrawUsage);
		colorAttribute.setUsage(DynamicDrawUsage);
		alphaAttribute.setUsage(DynamicDrawUsage);
		sizeAttribute.setUsage(DynamicDrawUsage);
		particleGeometry.setAttribute('position', positionAttribute);
		particleGeometry.setAttribute('color', colorAttribute);
		particleGeometry.setAttribute('alpha', alphaAttribute);
		particleGeometry.setAttribute('size', sizeAttribute);

		particleMaterial = new ShaderMaterial({
			transparent: true,
			depthWrite: false,
			blending: AdditiveBlending,
			uniforms: {
				pixelRatio: { value: getPixelRatio() }
			},
			vertexShader: `
				attribute float alpha;
				attribute float size;
				varying vec3 vColor;
				varying float vAlpha;
				uniform float pixelRatio;

				void main() {
					vColor = color;
					vAlpha = alpha;
					vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
					gl_PointSize = size * pixelRatio * (70.0 / max(18.0, -mvPosition.z));
					gl_Position = projectionMatrix * mvPosition;
				}
			`,
			fragmentShader: `
				varying vec3 vColor;
				varying float vAlpha;

				void main() {
					vec2 uv = gl_PointCoord - vec2(0.5);
					float d = length(uv);
					float core = smoothstep(0.5, 0.0, d);
					float glow = smoothstep(0.5, 0.08, d) * 0.28;
					float alpha = vAlpha * max(core, glow);
					if (alpha <= 0.01) discard;
					gl_FragColor = vec4(vColor, alpha);
				}
			`,
			vertexColors: true
		});
		particleLayer = new Points(particleGeometry, particleMaterial);
		particleLayer.frustumCulled = false;
		scene.add(particleLayer);
	}

	function updateCameraMotion(now: number) {
		if (!camera) return;
		cameraTarget.set(cameraTargetPosition.x, cameraTargetPosition.y, cameraTargetPosition.z);
		const loopT = (now / 1000 / cameraLoopSeconds) * Math.PI * 2;
		camera.position.set(
			cameraOrigin.x,
			cameraOrigin.y + Math.sin(loopT) * (isMobile ? 0.45 : 1.5),
			cameraOrigin.z
		);
		camera.lookAt(cameraTarget);
	}

	function formatCameraValue(value: number) {
		return Number(value.toFixed(2));
	}

	function formatVectorForCode(name: string, vector: { x: number; y: number; z: number }) {
		return `${name}.set(${formatCameraValue(vector.x)}, ${formatCameraValue(vector.y)}, ${formatCameraValue(vector.z)})`;
	}

	function moveCameraControl(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		if (event.metaKey || event.ctrlKey) return;

		event.preventDefault();
		const direction =
			event.key === 'ArrowLeft' || event.key === 'ArrowDown'
				? -cameraKeyboardStep
				: cameraKeyboardStep;
		const target = event.shiftKey ? cameraTargetPosition : cameraOrigin;
		const next = { ...target };

		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			next.x = formatCameraValue(next.x + direction);
		} else if (event.altKey) {
			next.z = formatCameraValue(next.z + direction);
		} else {
			next.y = formatCameraValue(next.y + direction);
		}

		if (event.shiftKey) {
			cameraTargetPosition = next;
		} else {
			cameraOrigin = next;
		}
	}

	function endpointSide() {
		return Math.random() < 0.5 ? -1 : 1;
	}

	function activateFloatParticle(line: LineNode, side: number) {
		if (
			!particlePositions ||
			!particleColors ||
			!particleAlphas ||
			!particleSizes ||
			!floatParticles.length
		) {
			return;
		}

		const particle = floatParticles[nextParticleIndex];
		const index = nextParticleIndex;
		nextParticleIndex = (nextParticleIndex + 1) % floatParticles.length;
		const tipWorldPosition = new Vector3();
		const tip = side < 0 ? line.tipLeft : line.tipRight;
		tip.getWorldPosition(tipWorldPosition);
		const inwardJitter = Math.pow(Math.random(), MathUtils.lerp(10, 30, particleEndpointBias));
		const x = tipWorldPosition.x - side * line.currentHalfLength * 0.055 * inwardJitter;
		const y = tipWorldPosition.y + MathUtils.lerp(0.01, 0.08, Math.random());
		const z = tipWorldPosition.z + MathUtils.lerp(-0.045, 0.045, Math.random());

		particle.active = true;
		particle.life = 0;
		particle.maxLife = MathUtils.lerp(5, 10, Math.random());
		particle.startX = x;
		particle.startY = y;
		particle.startZ = z;
		const endpointStrength = MathUtils.lerp(0.9, 1, particleEndpointBias);
		const outwardDrift = side * MathUtils.lerp(1.45, 2.45, endpointStrength);
		const randomDrift = MathUtils.lerp(-0.14, 0.14, Math.random());
		particle.driftX = randomDrift + outwardDrift * MathUtils.lerp(0.35, 1, particleEndpointBias);
		particle.driftZ = MathUtils.lerp(-0.45, 0.2, Math.random());
		particle.lift = MathUtils.lerp(0.8, 2.8, Math.random()) * MathUtils.lerp(1, 8, line.depthT);
		particle.size = MathUtils.lerp(isMobile ? 1.8 : 2.2, isMobile ? 4.4 : 5.8, Math.random());

		const offset3 = index * 3;
		particlePositions[offset3] = x;
		particlePositions[offset3 + 1] = y;
		particlePositions[offset3 + 2] = z;
		particleColors[offset3] = line.currentColor.r;
		particleColors[offset3 + 1] = line.currentColor.g;
		particleColors[offset3 + 2] = line.currentColor.b;
		particleAlphas[index] = 0.35;
		particleSizes[index] = particle.size;
	}

	function emitLineParticles() {
		if (!lines.length || !currentTrack?.bpm || !music || music.paused) return;
		const beatSeconds = 60 / currentTrack.bpm;
		const beatIndex = Math.floor(music.currentTime / beatSeconds);
		if (beatIndex === lastParticleBeatIndex) return;
		lastParticleBeatIndex = beatIndex;

		const minCount = Math.max(0, Math.floor(Math.min(particleMinPerLine, particleMaxPerLine)));
		const maxCount = Math.max(
			minCount,
			Math.floor(Math.max(particleMinPerLine, particleMaxPerLine))
		);

		for (const line of lines) {
			if (line.currentHalfLength <= 0.001) continue;
			const count = MathUtils.randInt(minCount, maxCount);
			for (let i = 0; i < count; i++) {
				activateFloatParticle(line, endpointSide());
			}
		}
	}

	function updateFloatParticles(delta: number) {
		if (
			!particleGeometry ||
			!particlePositions ||
			!particleAlphas ||
			!particleSizes ||
			!floatParticles.length
		) {
			return;
		}

		for (let i = 0; i < floatParticles.length; i++) {
			const particle = floatParticles[i];
			if (!particle.active) continue;
			particle.life += delta;
			const offset3 = i * 3;
			if (particle.life >= particle.maxLife) {
				particle.active = false;
				particleAlphas[i] = 0;
				particleSizes[i] = 0;
				continue;
			}

			const lifeT = particle.life / particle.maxLife;
			const cubicLift = lifeT * lifeT * lifeT;
			const driftEase = 1 - Math.pow(1 - lifeT, 3);
			const fadeIn = Math.min(1, lifeT / 0.08);
			const fadeOut = lifeT < 0.72 ? 1 : 1 - (lifeT - 0.72) / 0.28;

			particlePositions[offset3] = particle.startX + particle.driftX * driftEase;
			particlePositions[offset3 + 1] = particle.startY + particle.lift * cubicLift;
			particlePositions[offset3 + 2] = particle.startZ + particle.driftZ * driftEase;
			particleAlphas[i] = Math.max(0, fadeOut) * fadeIn * 0.38;
			particleSizes[i] = particle.size * MathUtils.lerp(0.75, 1.18, lifeT);
		}

		particleGeometry.attributes.position.needsUpdate = true;
		particleGeometry.attributes.alpha.needsUpdate = true;
		particleGeometry.attributes.size.needsUpdate = true;
		particleGeometry.attributes.color.needsUpdate = true;
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
		camera.position.set(cameraOrigin.x, cameraOrigin.y, cameraOrigin.z);

		groundGroup = new Group();
		scene.add(groundGroup);

		setupGroundLines();
		setupFloatParticles();
		updateCameraMotion(0);

		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		bokehPass = new BokehPass(scene, camera, {
			focus: 2,
			aperture: 0.00025,
			maxblur: 0.01
		});
		if (enableBokeh) {
			composer.addPass(bokehPass);
		}

		window.addEventListener('resize', onResize);
	}

	function updateGroundLines(energy: SceneEnergy, time: number) {
		if (!dataArray || !lines.length) return;

		const gradientStops = currentTrack?.gradientStops ?? ['#ff184c', '#1887ff'];
		const decay = isMobile ? lineGhostDecayMobile : lineGhostDecayDesktop;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const centerIndex = Math.round(line.spectrumT * (dataArray.length - 1));
			const bandRadius = Math.max(1, Math.floor(dataArray.length / Math.max(18, lines.length) / 2));
			const sampleStart = Math.max(0, centerIndex - bandRadius);
			const sampleEnd = Math.min(dataArray.length, centerIndex + bandRadius + 1);
			let sampleTotal = 0;
			let sampleCount = 0;
			let samplePeak = 0;
			for (let j = sampleStart; j < sampleEnd; j++) {
				const sample = dataArray[j];
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
			const coreRadius = shellRadius * 0.05;

			line.group.position.y = line.baseY + yLift;
			line.shell.scale.set(
				Math.max(0.001, shellRadius / 0.12),
				Math.max(0.001, shellHalfWidth),
				Math.max(0.001, shellRadius / 0.12)
			);
			line.core.scale.set(
				Math.max(0.001, coreRadius / 0.035),
				Math.max(0.001, coreHalfWidth * 0.95),
				Math.max(0.001, coreRadius / 0.035)
			);
			const coreHalfLength = coreHalfWidth * 0.5;
			const tipScale = (MathUtils.lerp(0.42, 0.88, nearWeight) + reactivePct * 0.35) * activity;
			line.tipRight.position.set(coreHalfLength - coreRadius * 0.15, 0, 0);
			line.tipRight.scale.setScalar(Math.max(0.001, tipScale));
			line.tipLeft.position.set(-coreHalfLength + coreRadius * 0.15, 0, 0);
			line.tipLeft.scale.setScalar(Math.max(0.001, tipScale));
			line.currentHalfLength = Math.max(0, coreHalfLength - coreRadius * 0.15);

			const gradientT = MathUtils.clamp(
				line.depthT * 0.82 + line.spectrumT * 0.16 + pulse * 0.08,
				0,
				1
			);
			const lineColor = sampleLineGradient(gradientT, gradientStops, pulse);
			const sat = MathUtils.lerp(1, 0.72, line.depthT);
			const lit = MathUtils.lerp(0.28, 0.92, Math.min(1, reactivePct * 0.7 + pulse * 0.8));
			const depthLit = MathUtils.lerp(lit, lit * 0.34, line.depthT * 0.8);
			line.currentColor.copy(lineColor);
			line.shellMaterial.color.setHSL(
				(lineColor.getHSL({ h: 0, s: 0, l: 0 }).h + 0.02) % 1,
				Math.min(0.82, sat * 0.4),
				Math.min(0.92, depthLit + 0.26)
			);
			line.coreMaterial.color.copy(lineColor);
			line.tipMaterial.color.copy(lineColor);

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
		}
		emitLineParticles();
		updateFloatParticles(delta);
		updateCameraMotion(now);

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

		if (particleLayer) {
			scene?.remove(particleLayer);
		}
		particleLayer = null;
		particleGeometry?.dispose();
		particleGeometry = null;
		particleMaterial?.dispose();
		particleMaterial = null;
		particlePositions = null;
		particleColors = null;
		particleAlphas = null;
		particleSizes = null;
		floatParticles = [];

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
		lastParticleBeatIndex = -1;
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

<svelte:window bind:innerWidth bind:innerHeight onkeydown={moveCameraControl} />

<div class="wrap">
	<div class="particle-tuning">
		<button
			class="particle-tuning-toggle"
			type="button"
			onclick={() => {
				showParticleTuning = !showParticleTuning;
			}}
		>
			{showParticleTuning ? 'Hide particles' : 'Particles'}
		</button>
		{#if showParticleTuning}
			<div class="particle-tuning-panel">
				<div class="particle-tuning-title">Point Particles</div>
				<label class="particle-control">
					<span>Min / line {particleMinPerLine}</span>
					<input type="range" min="0" max="40" step="1" bind:value={particleMinPerLine} />
				</label>
				<label class="particle-control">
					<span>Max / line {particleMaxPerLine}</span>
					<input type="range" min="0" max="80" step="1" bind:value={particleMaxPerLine} />
				</label>
				<label class="particle-control">
					<span>Endpoint Bias {particleEndpointBias.toFixed(2)}</span>
					<input type="range" min="0" max="1" step="0.01" bind:value={particleEndpointBias} />
				</label>
				<label class="particle-control checkbox">
					<input type="checkbox" bind:checked={enableBokeh} />
					<span>Enable Bokeh</span>
				</label>
				<div class="camera-readout">
					<div class="camera-readout-title">Camera</div>
					<code>{formatVectorForCode('camera.position', cameraOrigin)}</code>
					<code>{formatVectorForCode('cameraTarget', cameraTargetPosition)}</code>
					<div class="camera-help">
						Arrows move camera. Shift moves target. Option Up/Down moves Z.
					</div>
				</div>
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
	.particle-tuning {
		position: fixed;
		top: 14px;
		right: 14px;
		z-index: 4;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
	}
	.particle-tuning-toggle {
		background: rgba(9, 12, 22, 0.58);
		border: 1px solid rgba(255, 255, 255, 0.26);
		color: rgba(255, 255, 255, 0.92);
		padding: 6px 10px;
		border-radius: 8px;
		font-size: 11px;
		line-height: 1;
		font-family: inherit;
		cursor: pointer;
	}
	.particle-tuning-panel {
		width: min(260px, calc(100vw - 28px));
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
	.particle-tuning-title {
		margin-bottom: 8px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.particle-control {
		display: grid;
		gap: 3px;
		margin-top: 7px;
	}
	.particle-control span {
		display: flex;
		justify-content: space-between;
	}
	.particle-control input {
		width: 100%;
		accent-color: #9cdcff;
	}
	.checkbox {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.checkbox span {
		white-space: nowrap;
		width: fit-content;
	}
	.checkbox input {
		width: unset;
	}
	.camera-readout {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid rgba(255, 255, 255, 0.16);
	}
	.camera-readout-title {
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.camera-readout code {
		display: block;
		overflow-wrap: anywhere;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.28);
		padding: 6px;
		color: rgba(214, 241, 255, 0.94);
		font:
			10px/1.35 ui-monospace,
			SFMono-Regular,
			Menlo,
			Monaco,
			Consolas,
			monospace;
	}
	.camera-help {
		color: rgba(255, 255, 255, 0.58);
		font-size: 10px;
		line-height: 1.35;
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
