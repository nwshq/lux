<?php
namespace App\Nova;
use Laravel\Nova\Resource;
use App\Models\Offer as OfferModel;
class Offer extends Resource { public static string $model = OfferModel::class; }
