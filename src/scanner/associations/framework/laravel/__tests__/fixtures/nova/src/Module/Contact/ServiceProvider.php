<?php
namespace App\Module\Contact;
use Laravel\Nova\Nova;
use App\Module\Contact\Nova\Contact;
class ServiceProvider { public function boot(): void { Nova::resources([Contact::class]); } }
