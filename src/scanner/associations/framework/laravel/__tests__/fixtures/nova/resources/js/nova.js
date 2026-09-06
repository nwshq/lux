import MetricsTool from './components/MetricsTool.vue';
import AuditTool from './components/AuditTool.vue';
import StatusCard from './components/StatusCard.vue';
Nova.booting((app) => {
  app.component('metrics-tool', MetricsTool);
  app.component('audit-tool', AuditTool);
  app.component('status-card', StatusCard);
});
