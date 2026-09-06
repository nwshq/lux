<script lang="ts">
export default {
  emits: ['option-array-a', "option-array-b"],
  methods: {
    save() {
      this.$emit('option-call-a')
    },
    rename() {
      this.$emit("option-call-b")
    },
  },
  setup(_props, { emit: send }) {
    send('setup-destructure-alias')
    return () => send('setup-destructure-nested')
  },
}
</script>

<script setup lang="ts">
const emit = defineEmits([
  'runtime-array-a',
  "runtime-array-b",
])
const send = defineEmits({
  'runtime-object-quoted': null,
  runtimeObjectIdentifier: null,
})
const typed = defineEmits<{
  (event: 'typed-call-a'): void
  (event: 'typed-call-b' | 'typed-call-c'): void
  typedProperty: []
  'typed-quoted-property': [value: string]
}>()

emit('bound-call-a')
emit("bound-call-b")
send('bound-call-c')
typed('bound-call-d')
defineModel()
defineModel<number>('amount')
</script>

<template>
  <ChildCard
    @saved="onSaved"
    v-on:changed="onChanged"
    v-model="value"
    v-model:amount="amount"
    :legacy.sync="legacy"
  />
</template>
