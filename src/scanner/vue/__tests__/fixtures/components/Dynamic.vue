<script setup lang="ts">
import Unused from './Child.vue';
const Lazy = defineAsyncComponent(() => import('./Child.vue'));
const Dynamic = defineAsyncComponent(factory);
</script>
<template>
  <Lazy />
  <component :is="chosen" />
  <Unused v-on="listeners" @[event]="handler" v-model:[field]="value" />
  <section />
  <Transition /><slot />
</template>
