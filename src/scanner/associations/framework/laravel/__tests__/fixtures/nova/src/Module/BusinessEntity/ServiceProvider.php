<?php
namespace App\Module\BusinessEntity;
use Laravel\Nova\Nova as Admin;
use App\Module\BusinessEntity\Nova\BusinessEntity;
use App\Module\BusinessEntity\Nova\BusinessEntityAddress;
class ServiceProvider { public function boot(): void { Admin::resources([BusinessEntity::class, BusinessEntityAddress::class]); } }
