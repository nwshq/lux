<?php
namespace App\Module\Offers;
use App\Module\Offers\Nova\Offer;
use App\Module\Offers\Nova\OfferChain;
class ServiceProvider { public function resources(): array { return [Offer::class, OfferChain::class]; } }
