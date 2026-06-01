<script lang="ts">
	import { store } from '$lib/store.svelte';
	import type { Track } from '$lib/types';
	import { onDestroy, onMount } from 'svelte';
	import {
		AdditiveBlending,
		BufferAttribute,
		BufferGeometry,
		Color,
		DoubleSide,
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
		Vector2,
		Vector3,
		WebGLRenderer
	} from 'three';
	import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
	import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
	import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
	import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

	interface Props {
		currentTrack?: Track | null;
		music?: HTMLAudioElement | null;
		freqLow?: number;
		freqHigh?: number;
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
		activity: number;
		emissionCarry: number;
		curveEmissionCarry: number;
		smoothedPeak: number;
		agcPeak: number;
		curveOffsets: Float32Array;
		historyBuffer: Float32Array;
		historyHead: number;
		historyCount: number;
	}

	interface FloatParticle {
		active: boolean;
		life: number;
		maxLife: number;
		startX: number;
		startY: number;
		startZ: number;
		driftX: number;
		kickX: number;
		kickY: number;
		driftZ: number;
		kickZ: number;
		lift: number;
		size: number;
	}

	let { currentTrack = null, music = null, freqLow = 35, freqHigh = 14000 }: Props = $props();

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
	let bloomPass: UnrealBloomPass | null = null;
	let atmospherePass: ShaderPass | null = null;
	let groundGroup: Group | null = null;
	let cameraOrigin = { x: -17, y: 1, z: 10.5 };
	let cameraTargetPosition = { x: -6, y: 0, z: -15 };
	let cameraOrbitX = 0;
	let cameraOrbitY = 0;
	let cameraOrbitTargetX = 0;
	let cameraOrbitTargetY = 0;
	let particleLayer: Points | null = null;
	let particleGeometry: BufferGeometry | null = null;
	let particleMaterial: ShaderMaterial | null = null;
	let particlePositions: Float32Array | null = null;
	let particleColors: Float32Array | null = null;
	let particleAlphas: Float32Array | null = null;
	let particleSizes: Float32Array | null = null;
	let floatParticles: FloatParticle[] = [];
	let nextParticleIndex = 0;
	let lastWaveBeatIndex = -1;
	let waveBeatBoost = 0;
	let waveBeatBoostVelocity = 0;
	let lineTipGeometry: SphereGeometry | null = null;
	let lines: LineNode[] = [];
	let animationFrameId = 0;
	let previousFrameTime = 0;
	let smoothedBass = 0;
	let smoothedMid = 0;
	let smoothedTransient = 0;
	let scenePulse = 0;
	let previousCurveParticleScenePulse = 0;
	let rotY = 0;
	let rotX = 0;
	let rotZ = 0;
	let rotVelY = 0;
	let rotVelX = 0;
	let rotVelZ = 0;
	let particleMinPerLine = $state(0);
	let particleMaxPerLine = $state(120);
	let showParticleTuning = $state(false);
	let waveAmplitude = $state(60);
	let waveFloor = $state(0);

	const lineGhostDecayDesktop = 0.992;
	const lineGhostDecayMobile = 0.988;
	const lineCountDesktop = 60;
	const lineCountMobile = 26;
	const maxFloatParticlesDesktop = 100_000;
	const maxFloatParticlesMobile = 6000;
	const particleEmissionRateScale = 0.34;
	const curveParticleBurstMultiplier = 2;
	const curveParticlePulseThreshold = 0.6;
	const cameraOrbitMaxRadians = MathUtils.degToRad(30);
	const waveBeatBoostSpring = 42;
	const waveBeatBoostDamping = 9;
	const lineCurveSegments = 80;
	const curveScratch = new Float32Array(lineCurveSegments + 1);
	const historyCapacity = 256;
	const historyWindow = 1.0; // seconds of frequency history shown per line
	let avgDeltaTime = 1 / 60;
	const atmosphereShader = {
		uniforms: {
			tDiffuse: { value: null },
			resolution: { value: new Vector2(1, 1) },
			time: { value: 0 },
			streakStrength: { value: 0.18 },
			grainStrength: { value: 0.045 },
			vignetteStrength: { value: 0.42 }
		},
		vertexShader: `
			varying vec2 vUv;

			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform vec2 resolution;
			uniform float time;
			uniform float streakStrength;
			uniform float grainStrength;
			uniform float vignetteStrength;
			varying vec2 vUv;

			float rand(vec2 co) {
				return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
			}

			float dgPostLuma(vec3 color) {
				return dot(color, vec3(0.299, 0.587, 0.114));
			}

			void main() {
				vec4 base = texture2D(tDiffuse, vUv);
				vec2 texel = 1.0 / max(resolution, vec2(1.0));
				vec3 streak = vec3(0.0);

				for (int i = 1; i <= 8; i++) {
					float f = float(i);
					float weight = exp(-f * 0.34);
					vec3 left = texture2D(tDiffuse, vUv - vec2(texel.x * f * 5.5, 0.0)).rgb;
					vec3 right = texture2D(tDiffuse, vUv + vec2(texel.x * f * 5.5, 0.0)).rgb;
					streak += max(left - 0.32, 0.0) * weight;
					streak += max(right - 0.32, 0.0) * weight;
				}

				vec2 centered = vUv - 0.5;
				float vignette = smoothstep(0.92, 0.18, dot(centered, centered) * 1.65);
				float grain = (rand(gl_FragCoord.xy + time * 58.0) - 0.5) * grainStrength;
				vec3 color = base.rgb + streak * streakStrength;
				color += grain;
				color *= mix(1.0 - vignetteStrength, 1.0, vignette);
				color += pow(max(dgPostLuma(color) - 0.5, 0.0), 2.0) * vec3(0.04, 0.055, 0.08);

				gl_FragColor = vec4(color, base.a);
			}
		`
	};

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

	function sampleLineGradient(t: number, stops: string[], pulse: number) {
		const colorStops = stops.length
			? stops.map((stop) => new Color(stop))
			: [new Color('#ff184c'), new Color('#1887ff')];
		const scaled = MathUtils.clamp(t, 0, 1) * (colorStops.length - 1);
		const index = Math.min(colorStops.length - 2, Math.floor(scaled));
		const color = colorStops[index].clone().lerp(colorStops[index + 1], scaled - index);
		return color.lerp(new Color('#ffffff'), pulse * 0.1);
	}

	function readSceneEnergy(delta: number) {
		const bass = averageRange(0.01, 0.12);
		const mid = averageRange(0.12, 0.36);

		smoothedBass = MathUtils.lerp(smoothedBass, bass, Math.min(1, delta * 10));
		smoothedMid = MathUtils.lerp(smoothedMid, mid, Math.min(1, delta * 9));

		const rawTransient =
			Math.max(0, bass - smoothedBass * 0.84) + Math.max(0, mid - smoothedMid * 0.9);
		smoothedTransient = MathUtils.lerp(smoothedTransient, rawTransient, Math.min(1, delta * 16));
		scenePulse = Math.max(scenePulse * Math.pow(0.18, delta), smoothedTransient * 3.6);
		
	}

	function createLineStripGeometry() {
		const positions = new Float32Array((lineCurveSegments + 1) * 2 * 3);
		const indices: number[] = [];
		for (let i = 0; i < lineCurveSegments; i++) {
			const a = i * 2;
			const b = a + 1;
			const c = a + 2;
			const d = a + 3;
			indices.push(a, c, b, b, c, d);
		}
		const geometry = new BufferGeometry();
		const positionAttribute = new BufferAttribute(positions, 3);
		positionAttribute.setUsage(DynamicDrawUsage);
		geometry.setAttribute('position', positionAttribute);
		geometry.setIndex(indices);
		return geometry;
	}

	function updateLineStripGeometry(
		geometry: BufferGeometry,
		halfLength: number,
		halfThickness: number,
		curveOffsets: Float32Array
	) {
		const positions = geometry.attributes.position.array as Float32Array;
		const n = lineCurveSegments + 1;
		// Smooth display offsets only — endpoints anchored so tip positions stay correct
		for (let i = 0; i < n; i++) curveScratch[i] = curveOffsets[i];
		for (let pass = 0; pass < 3; pass++) {
			for (let i = 1; i < n - 1; i++) {
				curveScratch[i] =
					curveScratch[i - 1] * 0.25 + curveScratch[i] * 0.5 + curveScratch[i + 1] * 0.25;
			}
		}
		for (let i = 0; i <= lineCurveSegments; i++) {
			const t = i / lineCurveSegments;
			const x = MathUtils.lerp(-halfLength, halfLength, t);
			const y = curveScratch[i];
			const offset = i * 6;
			positions[offset] = x;
			positions[offset + 1] = y - halfThickness;
			positions[offset + 2] = 0;
			positions[offset + 3] = x;
			positions[offset + 4] = y + halfThickness;
			positions[offset + 5] = 0;
		}
		geometry.attributes.position.needsUpdate = true;
		geometry.computeBoundingSphere();
	}

	function setupGroundLines() {
		if (!groundGroup) return;

		for (const line of lines) {
			groundGroup.remove(line.group);
			line.shell.geometry.dispose();
			line.core.geometry.dispose();
			line.shellMaterial.dispose();
			line.coreMaterial.dispose();
			line.tipMaterial.dispose();
		}
		lines = [];
		groundGroup.clear();
		if (particleLayer) groundGroup.add(particleLayer);

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
				depthWrite: false,
				side: DoubleSide
			});
			const coreMaterial = new MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 0.92,
				blending: AdditiveBlending,
				depthWrite: false,
				side: DoubleSide
			});
			const tipMaterial = new MeshBasicMaterial({
				color: 0xffffff,
				transparent: true,
				opacity: 1,
				blending: AdditiveBlending,
				depthWrite: false
			});

			const shell = new Mesh(createLineStripGeometry(), shellMaterial);
			const core = new Mesh(createLineStripGeometry(), coreMaterial);

			const tipLeft = new Mesh(lineTipGeometry, tipMaterial);
			const tipRight = new Mesh(lineTipGeometry, tipMaterial);
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
				currentColor: new Color(0xffffff),
				activity: 0,
				emissionCarry: 0,
				curveEmissionCarry: 0,
				smoothedPeak: 0,
				agcPeak: 0,
				curveOffsets: new Float32Array(lineCurveSegments + 1),
				historyBuffer: new Float32Array(historyCapacity),
				historyHead: 0,
				historyCount: 0
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
		bloomPass?.setSize(width, height);
		if (atmospherePass) {
			atmospherePass.uniforms.resolution.value.set(
				width * getPixelRatio(),
				height * getPixelRatio()
			);
		}
		if (particleMaterial) {
			particleMaterial.uniforms.pixelRatio.value = getPixelRatio();
		}
	}

	function setupFloatParticles() {
		if (!scene || !groundGroup) return;

		if (particleLayer) {
			groundGroup.remove(particleLayer);
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
			kickX: 0,
			kickY: 0,
			driftZ: 0,
			kickZ: 0,
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
		groundGroup.add(particleLayer);
	}

	function updateGroupRotation(now: number, delta: number) {
		if (!groundGroup) return;
		const t = now / 1000;
		// Sine waves modulate angular velocity — rotation accumulates continuously,
		// never snapping back, just changing pace and direction gradually.
		const targetVelY =
			Math.sin(t * 0.0707) * 0.22 +
			Math.sin(t * 0.0412 + 1.31) * 0.12 +
			Math.sin(t * 0.0171 + 2.73) * 0.08;
		const targetVelX =
			Math.sin(t * 0.0283 + 0.94) * 0.10 +
			Math.sin(t * 0.0591 + 3.15) * 0.06 +
			Math.sin(t * 0.0131 + 1.82) * 0.07;
		const targetVelZ =
			Math.sin(t * 0.0523 + 0.40) * 0.04 +
			Math.sin(t * 0.0198 + 2.10) * 0.03;
		rotVelY = MathUtils.lerp(rotVelY, targetVelY, Math.min(1, delta * 1.2));
		// Spring restoring forces on X and Z keep scene from drifting off-screen;
		// Y is free to accumulate as a panoramic turntable rotation.
		rotVelX = MathUtils.lerp(rotVelX, targetVelX, Math.min(1, delta * 0.9));
		rotVelX -= rotX * 2.5 * delta;
		rotVelZ = MathUtils.lerp(rotVelZ, targetVelZ, Math.min(1, delta * 0.6));
		rotVelZ -= rotZ * 5.0 * delta;
		rotY += rotVelY * delta;
		rotX += rotVelX * delta;
		rotZ += rotVelZ * delta;
		groundGroup.rotation.set(rotX, rotY, rotZ);
	}

	function updateCameraMotion(now: number, delta: number) {
		if (!camera) return;
		cameraOrbitX = MathUtils.lerp(cameraOrbitX, cameraOrbitTargetX, Math.min(1, delta * 7));
		cameraOrbitY = MathUtils.lerp(cameraOrbitY, cameraOrbitTargetY, Math.min(1, delta * 7));
		const baseCameraTarget = new Vector3(
			cameraTargetPosition.x,
			cameraTargetPosition.y,
			cameraTargetPosition.z
		);
		const orbitOffset = new Vector3(
			cameraOrigin.x - cameraTargetPosition.x,
			cameraOrigin.y - cameraTargetPosition.y,
			cameraOrigin.z - cameraTargetPosition.z
		);
		orbitOffset.applyAxisAngle(new Vector3(0, 1, 0), cameraOrbitX * cameraOrbitMaxRadians);
		const pitchAxis = new Vector3().crossVectors(new Vector3(0, 1, 0), orbitOffset).normalize();
		orbitOffset.applyAxisAngle(pitchAxis, cameraOrbitY * cameraOrbitMaxRadians);
		camera.position.copy(baseCameraTarget).add(orbitOffset);
		// Always look at the world-space centre of the scene objects
		const sceneCenter = groundGroup
			? groundGroup.localToWorld(new Vector3(0, -2.7, -45))
			: baseCameraTarget;
		camera.lookAt(sceneCenter);
	}

	function updateCameraOrbit(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		if (innerWidth <= 0 || innerHeight <= 0) return;
		const normalizedX = MathUtils.clamp((event.clientX / innerWidth - 0.5) * 2, -1, 1);
		const normalizedY = MathUtils.clamp((event.clientY / innerHeight - 0.5) * 2, -1, 1);
		cameraOrbitTargetX = normalizedX;
		cameraOrbitTargetY = normalizedY;
	}

	function kickWaveformBoost() {
		waveBeatBoostVelocity += 9;
	}

	function updateWaveformBoost(delta: number) {
		const acceleration =
			-waveBeatBoost * waveBeatBoostSpring - waveBeatBoostVelocity * waveBeatBoostDamping;
		waveBeatBoostVelocity += acceleration * delta;
		waveBeatBoost += waveBeatBoostVelocity * delta;
		waveBeatBoost = Math.max(0, waveBeatBoost);
	}



	function endpointSide() {
		return Math.random() < 0.5 ? -1 : 1;
	}

	function getRandomCurveSpawn(line: LineNode) {
		const t = Math.random();
		const seg = t * lineCurveSegments;
		const seg0 = Math.floor(seg);
		const seg1 = Math.min(lineCurveSegments, seg0 + 1);
		const segFrac = seg - seg0;
		const x = MathUtils.lerp(-line.currentHalfLength, line.currentHalfLength, t);
		const y =
			MathUtils.lerp(line.curveOffsets[seg0], line.curveOffsets[seg1], segFrac) +
			MathUtils.lerp(0.004, 0.025, Math.random());
		const side = x < 0 ? -1 : 1;

		return {
			side: Math.abs(x) < line.currentHalfLength * 0.08 ? endpointSide() : side,
			position: new Vector3(
				x + MathUtils.lerp(-0.018, 0.018, Math.random()),
				y,
				MathUtils.lerp(-0.018, 0.018, Math.random())
			)
		};
	}

	function activateFloatParticle(line: LineNode, side: number, fromCurve = false) {
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
		const curveSpawn = fromCurve ? getRandomCurveSpawn(line) : null;
		if (curveSpawn) side = curveSpawn.side;
		const tip = side < 0 ? line.tipLeft : line.tipRight;
		const inwardJitter = Math.pow(Math.random(), 22);
		const spawnPosition =
			curveSpawn?.position ??
			new Vector3(
				tip.position.x - side * line.currentHalfLength * 0.014 * inwardJitter,
				tip.position.y + MathUtils.lerp(0.004, 0.025, Math.random()),
				tip.position.z + MathUtils.lerp(-0.018, 0.018, Math.random())
			);
		line.group.localToWorld(spawnPosition);
		groundGroup?.worldToLocal(spawnPosition);
		const x = spawnPosition.x;
		const y = spawnPosition.y;
		const z = spawnPosition.z;

		particle.active = true;
		particle.life = 0;
		particle.maxLife = MathUtils.lerp(5, 10, Math.random());
		particle.startX = x;
		particle.startY = y;
		particle.startZ = z;
		const activityKick = MathUtils.lerp(1, 1.45, line.activity);
		const domeAzimuth = MathUtils.lerp(-Math.PI * 0.5, Math.PI * 0.5, Math.random());
		const domeElevation = MathUtils.lerp(-Math.PI * 0.28, Math.PI * 0.42, Math.random());
		const kickMagnitude = MathUtils.lerp(0.9, 2.1, Math.random()) * activityKick * (fromCurve ? .2 : 1);
		particle.kickX = side * Math.cos(domeAzimuth) * Math.cos(domeElevation) * kickMagnitude;
		particle.kickY = Math.sin(domeElevation) * kickMagnitude;
		particle.kickZ = Math.sin(domeAzimuth) * Math.cos(domeElevation) * kickMagnitude;
		particle.driftX =
			side * MathUtils.lerp(0.28, 0.72, Math.random()) + MathUtils.lerp(-0.08, 0.08, Math.random());
		particle.driftZ = MathUtils.lerp(-0.26, 0.12, Math.random());
		particle.lift = MathUtils.lerp(0.8, 2.8, Math.random()) * MathUtils.lerp(1, 8, line.depthT) * (fromCurve ? 4 : 1);
		particle.size = MathUtils.lerp(isMobile ? 1.8 : 2.2, isMobile ? 4.4 : 5.8, Math.random()) * (fromCurve ? .5 : 1);

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

	function updateBeatBoost() {
		if (!currentTrack?.bpm || !music || music.paused) return;
		const beatSeconds = 60 / currentTrack.bpm;
		const beatIndex = Math.floor(music.currentTime / beatSeconds);
		if (beatIndex !== lastWaveBeatIndex) {
			lastWaveBeatIndex = beatIndex;
			kickWaveformBoost();
		}
	}

	function emitLineParticles(delta: number) {
		if (!lines.length || !music || music.paused) return;

		const minRate = Math.max(0, Math.min(particleMinPerLine, particleMaxPerLine));
		const maxRate = Math.max(minRate, Math.max(particleMinPerLine, particleMaxPerLine));
		const shouldEmitCurveParticles =
			scenePulse >= curveParticlePulseThreshold &&
			previousCurveParticleScenePulse != curveParticlePulseThreshold;
		console.log('shouldEmitCurveParticles', shouldEmitCurveParticles, scenePulse);
		for (const line of lines) {
			if (line.currentHalfLength <= 0.001) continue;
			const activityBurst = Math.pow(MathUtils.clamp(line.activity, 0, 1), 2.2);
			const ratePerSecond =
				MathUtils.lerp(minRate, maxRate, activityBurst) * particleEmissionRateScale;
			line.emissionCarry += ratePerSecond * delta;
			if (Math.random() < activityBurst * delta * 5.5) {
				line.emissionCarry += MathUtils.lerp(1, 5, activityBurst);
			}

			const count = Math.min(12, Math.floor(line.emissionCarry));
			line.emissionCarry -= count;
			for (let i = 0; i < count; i++) {
				activateFloatParticle(line, endpointSide());
			}

			if (!shouldEmitCurveParticles) continue;

			line.curveEmissionCarry +=
				MathUtils.lerp(minRate, maxRate, activityBurst) *
				scenePulse *
				curveParticleBurstMultiplier;
			const curveCount = Math.min(
				Math.ceil(12 * curveParticleBurstMultiplier),
				Math.floor(line.curveEmissionCarry)
			);
			line.curveEmissionCarry -= curveCount;
			for (let i = 0; i < curveCount; i++) {
				activateFloatParticle(line, endpointSide(), true);
			}
		}
		previousCurveParticleScenePulse = scenePulse;
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
			const kickEase = 1 - Math.exp(-lifeT * 16);
			const kickDampen = Math.exp(-lifeT * 12);
			const fadeOut = lifeT < 0.72 ? 1 : 1 - (lifeT - 0.72) / 0.28;

			particlePositions[offset3] =
				particle.startX + particle.kickX * kickEase * kickDampen + particle.driftX * driftEase;
			particlePositions[offset3 + 1] =
				particle.startY + particle.kickY * kickEase * kickDampen + particle.lift * cubicLift;
			particlePositions[offset3 + 2] =
				particle.startZ + particle.kickZ * kickEase * kickDampen + particle.driftZ * driftEase;
			particleAlphas[i] = Math.max(0, fadeOut) * 0.38;
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
		updateCameraMotion(0, 0.016);

		composer = new EffectComposer(renderer);
		composer.addPass(new RenderPass(scene, camera));
		bloomPass = new UnrealBloomPass(
			new Vector2(width * getPixelRatio(), height * getPixelRatio()),
			isMobile ? 0.42 : 0.58,
			isMobile ? 0.72 : 0.84,
			0.48
		);
		composer.addPass(bloomPass);
		atmospherePass = new ShaderPass(atmosphereShader);
		atmospherePass.uniforms.resolution.value.set(width * getPixelRatio(), height * getPixelRatio());
		composer.addPass(atmospherePass);

		window.addEventListener('resize', onResize);
	}

	function syncAnalyserData() {
		if (!store.analyser) return;
		const nextBufferLength = store.analyser.frequencyBinCount;
		if (!nextBufferLength || nextBufferLength === bufferLength) return;
		bufferLength = nextBufferLength;
		dataArray = new Uint8Array(bufferLength);
		ghostArray = new Float32Array(bufferLength);
		setupGroundLines();
	}

	function updateGroundLines(delta: number) {
		if (!dataArray || !lines.length) return;

		const gradientStops = currentTrack?.gradientStops ?? ['#ff184c', '#1887ff'];
		const decay = isMobile ? lineGhostDecayMobile : lineGhostDecayDesktop;
		updateWaveformBoost(delta);

		const sampleRate = store.audioContext?.sampleRate ?? 48000;
		const nyquist = sampleRate / 2;
		const freqBandLow = Math.max(0, Math.round(freqLow / nyquist * (dataArray.length - 1)));
		const freqBandHigh = Math.min(dataArray.length - 1, Math.round(freqHigh / nyquist * (dataArray.length - 1)));

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const centerIndex = Math.round(MathUtils.lerp(freqBandLow, freqBandHigh, line.spectrumT));
			const bandRadius = Math.max(1, Math.floor((freqBandHigh - freqBandLow) / Math.max(18, lines.length) / 2));
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
			line.activity = MathUtils.lerp(line.activity, activity, Math.min(1, delta * 12));
			const viewportWidthAtLine = getViewportWidthAtZ(line.group.position.z);
			// Center signal: 0.5 audio → 0 Y, 0 → -1, 1 → +1
			const centeredPct = (peakPct - 0.5) * 2;
			if (line.historyCount === 0) {
				line.smoothedPeak = centeredPct;
			}
			// Asymmetric EMA: fast attack captures transients, slow release keeps dips visible (Option B)
			const smoothAlpha = centeredPct >= line.smoothedPeak
				? Math.min(1, delta * 4)      // fast attack τ ≈ 0.25s
				: Math.min(1, delta * 0.35);  // slow release τ ≈ 2.86s
			line.smoothedPeak = MathUtils.lerp(line.smoothedPeak, centeredPct, smoothAlpha);
			const rawDeviation = centeredPct - line.smoothedPeak;
			// AGC: asymmetric peak tracker — fast attack on new peaks, slow release builds gain during quiet passages (Option A)
			const absDeviation = Math.abs(rawDeviation);
			const agcAlpha = absDeviation > line.agcPeak
				? Math.min(1, delta * 10)    // fast attack τ ≈ 0.1s
				: Math.min(1, delta * 0.15); // slow release τ ≈ 6.7s
			line.agcPeak = Math.max(0.003, MathUtils.lerp(line.agcPeak, absDeviation, agcAlpha));
			const agcGain = Math.min(20, 0.06 / line.agcPeak);
			line.historyBuffer[line.historyHead] = rawDeviation * agcGain;
			line.historyHead = (line.historyHead + 1) % historyCapacity;
			line.historyCount = Math.min(line.historyCount + 1, historyCapacity);
			// Center-out mapping: center = newest sample, both edges = oldest (symmetric waveform)
			const samplesInWindow = Math.max(2, Math.min(line.historyCount, Math.round(historyWindow / avgDeltaTime)));
			const displayScale =
				viewportWidthAtLine *
				MathUtils.lerp(0.003, 0.038, waveAmplitude / 10) *
				(1 + Math.min(2.4, waveBeatBoost));
			const halfSegs = lineCurveSegments / 2;
			// Power-curve floor lift: quiet signals expand toward the noise floor, peaks unchanged.
			// waveFloor=0 → exponent 1.0 (no change); waveFloor=10 → exponent 0.2 (strong lift).
			const floorPow = MathUtils.lerp(1.0, 0.2, waveFloor / 10);
			for (let seg = 0; seg <= lineCurveSegments; seg++) {
				const distFromCenter = Math.abs(seg - halfSegs);
				const t_age = distFromCenter / halfSegs; // 0 = center/newest, 1 = edge/oldest
				const rawAge = t_age * (samplesInWindow - 1);
				const ageFloor = Math.floor(rawAge);
				const ageFrac = rawAge - ageFloor;
				const idx0 = ((line.historyHead - 1 - ageFloor) % historyCapacity + historyCapacity) % historyCapacity;
				const idx1 = ((line.historyHead - 2 - ageFloor) % historyCapacity + historyCapacity) % historyCapacity;
				const historicValue = MathUtils.lerp(line.historyBuffer[idx0], line.historyBuffer[idx1], ageFrac);
				const mag = Math.abs(historicValue);
				const lifted = mag > 0 ? Math.pow(mag, floorPow) : 0;
				const target = Math.sign(historicValue) * lifted * displayScale;
				line.curveOffsets[seg] = MathUtils.lerp(line.curveOffsets[seg], target, Math.min(1, delta * 18));
			}
			const yLift = pulse * MathUtils.lerp(0.01, 0.08, nearWeight);
			// Fixed half-length — only varies by depth position, not by frequency activity
			const fixedHalfLength = 0.5 * viewportWidthAtLine * MathUtils.lerp(0.04, 0.18, nearWeight);
			const shellRadius =
				viewportWidthAtLine * MathUtils.lerp(0.00022, 0.00078, nearWeight) +
				MathUtils.lerp(0.005, 0.012, nearWeight);
			const coreRadius = shellRadius * 0.05;

			line.group.position.y = line.baseY + yLift;
			updateLineStripGeometry(
				line.shell.geometry,
				fixedHalfLength,
				shellRadius,
				line.curveOffsets
			);
			updateLineStripGeometry(
				line.core.geometry,
				fixedHalfLength * 0.95,
				Math.max(0.001, coreRadius),
				line.curveOffsets
			);
			const tipScale = (MathUtils.lerp(0.42, 0.88, nearWeight) + reactivePct * 0.35) * activity;
			const coreHalfLength = fixedHalfLength * 0.95;
			line.tipRight.position.set(
				coreHalfLength - coreRadius * 0.15,
				line.curveOffsets[lineCurveSegments],
				0
			);
			line.tipRight.scale.setScalar(Math.max(0.001, tipScale));
			line.tipLeft.position.set(-(coreHalfLength - coreRadius * 0.15), line.curveOffsets[0], 0);
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
		avgDeltaTime = MathUtils.lerp(avgDeltaTime, delta, 0.05);
		syncAnalyserData();

		if (store.analyser && dataArray) {
			store.analyser.getByteFrequencyData(dataArray);
			readSceneEnergy(delta);
			updateGroundLines(delta);
		}
		updateBeatBoost();
		emitLineParticles(delta);
		updateFloatParticles(delta);
		updateGroupRotation(now, delta);
		updateCameraMotion(now, delta);
		if (atmospherePass) {
			atmospherePass.uniforms.time.value = now / 1000;
			atmospherePass.uniforms.streakStrength.value = MathUtils.lerp(
				atmospherePass.uniforms.streakStrength.value,
				0.14 + Math.min(0.18, waveBeatBoost * 0.04 + scenePulse * 0.03),
				Math.min(1, delta * 4)
			);
		}
		if (bloomPass) {
			bloomPass.strength = MathUtils.lerp(
				bloomPass.strength,
				(isMobile ? 0.38 : 0.52) + Math.min(0.25, waveBeatBoost * 0.04 + scenePulse * 0.05),
				Math.min(1, delta * 5)
			);
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
			line.shell.geometry.dispose();
			line.core.geometry.dispose();
			line.shellMaterial.dispose();
			line.coreMaterial.dispose();
			line.tipMaterial.dispose();
		}
		lines = [];

		lineTipGeometry?.dispose();
		lineTipGeometry = null;

		if (particleLayer) {
			groundGroup?.remove(particleLayer);
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
		bloomPass?.dispose();
		bloomPass = null;
		atmospherePass?.dispose();
		atmospherePass = null;

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
</script>

<svelte:window bind:innerWidth bind:innerHeight onpointermove={updateCameraOrbit} />

<div class="wrap">
	<div class="particle-tuning">
		<!-- <button
			class="particle-tuning-toggle"
			type="button"
			onclick={() => {
				showParticleTuning = !showParticleTuning;
			}}
		>
			{showParticleTuning ? 'Hide particles' : 'Particles'}
		</button> -->
		{#if showParticleTuning}
			<div class="particle-tuning-panel">
				<div class="particle-tuning-title">Point Particles</div>
				<label class="particle-control">
					<span>Idle Rate {particleMinPerLine}</span>
					<input type="range" min="0" max="40" step="1" bind:value={particleMinPerLine} />
				</label>
				<label class="particle-control">
					<span>Burst Rate {particleMaxPerLine}</span>
					<input type="range" min="0" max="80" step="1" bind:value={particleMaxPerLine} />
				</label>
				<label class="particle-control">
					<span>Wave Amp {waveAmplitude.toFixed(1)}</span>
					<input type="range" min="0.5" max="10" step="0.1" bind:value={waveAmplitude} />
				</label>
				<label class="particle-control">
					<span>Wave Floor {waveFloor.toFixed(1)}</span>
					<input type="range" min="0" max="10" step="0.1" bind:value={waveFloor} />
				</label>
			</div>
		{/if}
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
	canvas {
		position: fixed;
		height: 100vh;
		width: 100%;
		top: 0;
		left: 0;
		z-index: 0;
	}
</style>
