<script setup lang="ts">
// Renders one ```mermaid block in the browser. Mermaid is loaded only on pages that have a diagram, and the diagram
// is drawn again in the other colours when the reader switches between light and dark.
import { onMounted, ref, watch } from "vue";
import { useData } from "vitepress";

const props = defineProps<{ code: string }>();
const { isDark } = useData();
const svg = ref("");
const error = ref("");
let count = 0;

async function render() {
  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark.value ? "dark" : "default",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      themeVariables: isDark.value
        ? { primaryColor: "#2a2417", primaryBorderColor: "#f5a524", lineColor: "#c9a35a", primaryTextColor: "#ecebe8" }
        : { primaryColor: "#fff3dc", primaryBorderColor: "#d68a0c", lineColor: "#8a6a2c", primaryTextColor: "#1d1b18" },
    });
    const id = `tl-mermaid-${Math.random().toString(36).slice(2)}-${count++}`;
    svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
    error.value = "";
  } catch (e) {
    error.value = String((e as Error)?.message ?? e);
  }
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div v-if="svg" class="tl-mermaid" v-html="svg" />
  <pre v-else-if="error" class="tl-mermaid-error">Diagram error: {{ error }}</pre>
  <div v-else class="tl-mermaid tl-mermaid-loading">Drawing the diagram…</div>
</template>

<style scoped>
.tl-mermaid {
  display: flex;
  justify-content: center;
  margin: 16px 0;
  padding: 16px;
  overflow-x: auto;
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.tl-mermaid :deep(svg) { max-width: 100%; height: auto; }
.tl-mermaid-loading { color: var(--vp-c-text-3); font-size: 14px; min-height: 120px; align-items: center; }
.tl-mermaid-error { color: var(--vp-c-danger-1); white-space: pre-wrap; font-size: 13px; }
</style>
