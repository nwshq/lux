<?php
namespace App\Providers;
use Laravel\Nova\Nova;
use App\Nova\Offer;
use App\Nova\Contact;
use App\Nova\BusinessEntity;
use App\Nova\Tools\MetricsTool;
use App\Nova\Tools\AuditTool;
class NovaServiceProvider {
    public function boot(): void {
        Nova::resources([Offer::class, Contact::class]);
        Nova::resources([Offer::class]); // duplicate: resolver must deduplicate
        Nova::resourcesIn('app/Nova/Discovered');
        Nova::tools([new MetricsTool]);
        Nova::script('nova-shell', base_path('resources/js/nova.js'));
        Nova::script('dashboard-sfc', 'resources/js/components/Dashboard.vue');
        Nova::style('nova-theme', resource_path('css/nova.css'));
    }
    public function resources(): array { return [BusinessEntity::class]; }
    public function tools(): array { return [new AuditTool()]; }
}
