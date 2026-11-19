<script lang="ts">
  import BubbleRow from "./BubbleRow.svelte";
  import { type Bubble, errorMessage, listBubbles } from "./lib/api";

  const REFRESH_INTERVAL_MS = 3000;

  let bubbles = $state<Bubble[]>([]);
  let loaded = $state(false);
  let error = $state("");

  const refresh = async () => {
    try {
      bubbles = await listBubbles();
      error = "";
    } catch (err) {
      error = errorMessage(err);
    } finally {
      loaded = true;
    }
  };

  $effect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  });
</script>

<section>
  <div class="toolbar">
    <h2>Bubbles <span class="muted">{bubbles.length}</span></h2>
    {#if error}
      <span class="error" role="alert">{error}</span>
    {/if}
  </div>
  <div class="frame">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Snapshot</th>
          <th>Routing</th>
          <th class="actions"></th>
        </tr>
      </thead>
      {#each bubbles as bubble (bubble.name)}
        <BubbleRow {bubble} onchange={refresh} />
      {:else}
        <tbody>
          <tr>
            <td colspan="5" class="empty">
              {loaded ? "No bubbles" : "Loading…"}
            </td>
          </tr>
        </tbody>
      {/each}
    </table>
  </div>
</section>

<style>
  .frame {
    overflow-x: auto;
    background: var(--surface);
    border: 1px solid var(--border);
  }

  table :global(tbody:last-child > tr:last-child > td) {
    border-bottom: 0;
  }
</style>
