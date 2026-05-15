<script lang="ts">
	interface Props {
		isPlaying?: boolean;
	}

	let { isPlaying = false }: Props = $props();
</script>

<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
	<g>
		<rect x="1" y="1" width="30" height="30" rx="15" class="circle" />
		{#if isPlaying}
			<rect x="10.63" y="10" width="3.25" height="12" rx="1.5" />
			<rect x="18.63" y="10" width="3.25" height="12" rx="1.5" />
		{:else}
			<path
				d="M21.5 15.1339C22.1667 15.5188 22.1667 16.4811 21.5 16.866L13.0625 21.7373C12.3958 22.1222 11.5625 21.6411 11.5625 20.8713L11.5625 11.1285C11.5625 10.3587 12.3958 9.87761 13.0625 10.2625L21.5 15.1339Z"
				stroke-linejoin="round"
			/>
		{/if}
	</g>
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: 100%;
	}
	g {
		stroke: white;
		stroke-width: 1px;
	}
</style>
