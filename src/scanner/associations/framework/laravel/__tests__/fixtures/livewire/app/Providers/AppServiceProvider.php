<?php

namespace App\Providers;

use App\Livewire\RegisteredPanel;
use Livewire\Livewire;

class AppServiceProvider
{
    public function boot(): void
    {
        Livewire::component('marketing.hero', RegisteredPanel::class);
        $this->loadViewsFrom(resource_path('views/vendor/acme'), 'acme');
    }
}
