<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { loadMermaid } from './mermaidRuntime';

const props = defineProps<{ encoded: string }>();
const container = ref<HTMLElement>();
const error = ref('');
const id = `docs-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`;
let revision = 0;
async function render() {
  const current = ++revision;
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`${id}-${current}`, decodeURIComponent(props.encoded));
    if (current === revision && container.value) {
      // Mermaid sanitizes the SVG in strict mode; interactive callbacks remain disabled.
      container.value.innerHTML = svg;
      error.value = '';
    }
  } catch {
    if (current === revision) error.value = 'Diagram could not be rendered.';
  }
}
onMounted(render);
watch(() => props.encoded, render);
onBeforeUnmount(() => { revision++; });
</script>

<template>
  <div class="mermaid" role="img" aria-label="Architecture diagram">
    <div ref="container"></div>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
