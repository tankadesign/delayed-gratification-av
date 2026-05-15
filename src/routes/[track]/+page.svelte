<script lang="ts">
	import App from '$lib/components/App.svelte';
	import type { PageData } from './$types';

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();

	let trackName = $derived(data.track?.name.length ? `${data.track.name} | ` : '');
</script>

<svelte:head>
	<title>"{trackName}"j.Falcon | "Undefined"</title>
</svelte:head>

<App currentTrack={data.track} />
