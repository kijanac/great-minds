<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";

  onMount(() => {
    const type = page.url.searchParams.get("type");
    void goto(type ? `/library?type=${encodeURIComponent(type)}` : "/library", {
      replaceState: true,
    });
  });
</script>
