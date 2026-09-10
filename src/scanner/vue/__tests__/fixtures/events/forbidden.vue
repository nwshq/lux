<script setup lang="ts">
const suffix = 'saved';
const declared = ['spread-declaration'];
const handlers = {};
const emit = (name: string) => name;
const defineEmits = (value: unknown) => value;
const defineModel = (value?: unknown) => value;

defineEmits([`template-${suffix}`, 'concat-' + suffix, ...declared]);
defineEmits({
  ['computed-key']: null,
  ...handlers,
});
emit('shadowed-emit');
emit(`dynamic-${suffix}`);
emit('concat-' + suffix);
defineModel(suffix);
</script>

<script lang="ts">
export default {
  emits: [...declared],
  methods: {
    bad() {
      this.$emit(suffix);
      this.$emit(`template-${suffix}`);
      this.$emit('concat-' + suffix);
    },
  },
  setup(_props, context) {
    function emit(name: string) {
      return name;
    }
    emit('local-shadow');
    const { emit: send } = handlers;
    send('unestablished-destructure');
    context.emit('established-context');
  },
};
</script>

<template>
  <ChildCard
    v-on="handlers"
    @[eventName]="handler"
    v-model:[field]="value"
    :[property].sync="value"
    v-bind="$attrs"
  />
</template>
