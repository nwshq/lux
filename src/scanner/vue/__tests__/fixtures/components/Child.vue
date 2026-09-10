<script setup lang="ts">
const emit = defineEmits(['saved']);
</script>
<template>
  <button @click="emit('saved')"><slot /></button>
</template>
