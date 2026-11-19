<script lang="ts">
  import BubbleTable from "./BubbleTable.svelte";
  import Login from "./Login.svelte";
  import { session } from "./lib/session.svelte";
</script>

{#if session.current}
  <header>
    <div class="bar">
      <span class="brand">nibble</span>
      <button type="button" onclick={session.end}>Sign out</button>
    </div>
  </header>
  <main>
    <BubbleTable />
  </main>
{:else}
  <Login />
{/if}

<style>
  header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .bar,
  main {
    max-width: 960px;
    margin: 0 auto;
    padding-inline: 1rem;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-block: 0.6rem;
  }

  .brand {
    font-family: var(--font-mono);
    font-weight: 700;
  }

  main {
    padding-block: 1.5rem;
  }
</style>
