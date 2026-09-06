<script lang="ts">
import LegacyChild from './Child.vue'
import { defineComponent } from 'vue'
export default defineComponent({
  components: { LegacyChild, Alias: LegacyChild },
  emits: ['ready']
})
</script>
<script setup lang="ts">
import SetupChild from './Child.vue'
import { useThing as aliasedThing } from './useThing'
const café = aliasedThing('static')
const emit = defineEmits<{ (event: 'saved'): void; changed: [] }>()
emit('saved')
</script>
<template>
  <!-- 😀 UTF-16 before the observed element -->
  <setup-child @saved="onSaved" v-model:amount="café" />
  <Alias @ready="onReady" />
  <component is="LegacyChild" />
  <component :is="selected" />
  <div @click="noEdge" />
  <Teleport><LegacyChild /></Teleport>
</template>
