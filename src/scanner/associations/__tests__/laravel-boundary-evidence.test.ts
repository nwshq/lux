import { describe, expect, it } from 'vitest';
import { LaravelBoundaryEvidenceResolver } from '../framework/laravel-boundary-evidence.js';
import type { AssociationContext } from '../types.js';

const ROOT = '/repo';

function makeContext(entries: Array<{ filePath: string; content: string }>): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((entry) => ({
      filePath: entry.filePath,
      languageId: 'php',
      metadata: { content: entry.content },
    })),
    dirtyFiles: [],
  };
}

function findEdge(ids: string[], edgeId: string): boolean {
  return ids.includes(edgeId);
}

describe('LaravelBoundaryEvidenceResolver', () => {
  const resolver = new LaravelBoundaryEvidenceResolver();

  it('emits service/container evidence across module boundaries', async () => {
    const context = makeContext([
      {
        filePath: 'src/Module/Sales/Contracts/BillingGateway.php',
        content: `<?php
namespace App\\Module\\Sales\\Contracts;
interface BillingGateway {}
`,
      },
      {
        filePath: 'src/Module/Billing/Services/BillingService.php',
        content: `<?php
namespace App\\Module\\Billing\\Services;
class BillingService {}
`,
      },
      {
        filePath: 'src/Module/Checkout/Providers/BillingIntegrationProvider.php',
        content: `<?php
namespace App\\Module\\Checkout\\Providers;

use App\\Module\\Sales\\Contracts\\BillingGateway;
use App\\Module\\Billing\\Services\\BillingService;

class BillingIntegrationProvider
{
    public function register(): void
    {
        $this->app->bind(BillingGateway::class, BillingService::class);
    }
}
`,
      },
      {
        filePath: 'src/Module/Checkout/Services/CheckoutService.php',
        content: `<?php
namespace App\\Module\\Checkout\\Services;

use App\\Module\\Sales\\Contracts\\BillingGateway;

class CheckoutService
{
    public function __construct(private BillingGateway $gateway) {}
}
`,
      },
    ]);

    const edges = await resolver.resolve(context);
    const ids = edges.map((edge) => edge.id);

    expect(
      findEdge(
        ids,
        'file:src/Module/Checkout/Services/CheckoutService.php→file:src/Module/Sales/Contracts/BillingGateway.php:resolves_service'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/Checkout/Providers/BillingIntegrationProvider.php→file:src/Module/Billing/Services/BillingService.php:binds_service'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/Billing/Services/BillingService.php→file:src/Module/Sales/Contracts/BillingGateway.php:provides_capability'
      )
    ).toBe(true);
  });

  it('emits async workflow evidence for jobs and events', async () => {
    const context = makeContext([
      {
        filePath: 'src/Module/Billing/Jobs/SendInvoiceJob.php',
        content: `<?php
namespace App\\Module\\Billing\\Jobs;

use Illuminate\\Contracts\\Queue\\ShouldQueue;

class SendInvoiceJob implements ShouldQueue
{
    public function handle(): void {}
}
`,
      },
      {
        filePath: 'src/Module/Ordering/Events/OrderPlaced.php',
        content: `<?php
namespace App\\Module\\Ordering\\Events;

use Illuminate\\Foundation\\Events\\Dispatchable;

class OrderPlaced
{
    use Dispatchable;
}
`,
      },
      {
        filePath: 'src/Module/Analytics/Listeners/RecordInvoiceJob.php',
        content: `<?php
namespace App\\Module\\Analytics\\Listeners;

use App\\Module\\Billing\\Jobs\\SendInvoiceJob;

class RecordInvoiceJob
{
    public function handle(SendInvoiceJob $job): void {}
}
`,
      },
      {
        filePath: 'src/Module/Analytics/Listeners/RecordOrderAnalytics.php',
        content: `<?php
namespace App\\Module\\Analytics\\Listeners;
class RecordOrderAnalytics {}
`,
      },
      {
        filePath: 'src/Module/Analytics/Providers/EventServiceProvider.php',
        content: `<?php
namespace App\\Module\\Analytics\\Providers;

use App\\Module\\Ordering\\Events\\OrderPlaced;
use App\\Module\\Analytics\\Listeners\\RecordOrderAnalytics;

class EventServiceProvider
{
    protected $listen = [
        OrderPlaced::class => [
            RecordOrderAnalytics::class,
        ],
    ];
}
`,
      },
      {
        filePath: 'src/Module/Checkout/Actions/PlaceOrder.php',
        content: `<?php
namespace App\\Module\\Checkout\\Actions;

use App\\Module\\Billing\\Jobs\\SendInvoiceJob;
use App\\Module\\Ordering\\Events\\OrderPlaced;

class PlaceOrder
{
    public function handle(): void
    {
        SendInvoiceJob::dispatch();
        event(new OrderPlaced());
    }
}
`,
      },
    ]);

    const edges = await resolver.resolve(context);
    const ids = edges.map((edge) => edge.id);

    expect(
      findEdge(
        ids,
        'file:src/Module/Checkout/Actions/PlaceOrder.php→file:src/Module/Billing/Jobs/SendInvoiceJob.php:dispatches_job'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/Analytics/Listeners/RecordInvoiceJob.php→file:src/Module/Billing/Jobs/SendInvoiceJob.php:handles_job'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/Checkout/Actions/PlaceOrder.php→file:src/Module/Ordering/Events/OrderPlaced.php:emits_event'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/Analytics/Listeners/RecordOrderAnalytics.php→file:src/Module/Ordering/Events/OrderPlaced.php:listens_event'
      )
    ).toBe(true);
  });

  it('emits contract, resource, transform, and pipeline evidence', async () => {
    const context = makeContext([
      {
        filePath: 'src/Module/Listing/Requests/StoreListingRequest.php',
        content: `<?php
namespace App\\Module\\Listing\\Requests;
class StoreListingRequest {}
`,
      },
      {
        filePath: 'src/Module/Listing/Resources/ListingResource.php',
        content: `<?php
namespace App\\Module\\Listing\\Resources;
class ListingResource {}
`,
      },
      {
        filePath: 'src/Module/Listing/Models/Listing.php',
        content: `<?php
namespace App\\Module\\Listing\\Models;
class Listing {}
`,
      },
      {
        filePath: 'src/Module/MobileApi/Controllers/MobileListingController.php',
        content: `<?php
namespace App\\Module\\MobileApi\\Controllers;

use App\\Module\\Listing\\Requests\\StoreListingRequest;
use App\\Module\\Listing\\Resources\\ListingResource;

class MobileListingController
{
    public function store(StoreListingRequest $request): ListingResource
    {
        return new ListingResource();
    }
}
`,
      },
      {
        filePath: 'src/Module/MobileApi/Resources/MobileListingResource.php',
        content: `<?php
namespace App\\Module\\MobileApi\\Resources;

use App\\Module\\Listing\\Models\\Listing;

class MobileListingResource
{
    public function from(Listing $listing): array
    {
        return [];
    }
}
`,
      },
      {
        filePath: 'src/Module/ListingImport/Services/RunImport.php',
        content: `<?php
namespace App\\Module\\ListingImport\\Services;

use App\\Module\\Listing\\Models\\Listing;
use App\\Module\\Listing\\Resources\\ListingResource;

class RunImport
{
    public function handle(): void
    {
        new ListingResource();
    }
}
`,
      },
    ]);

    const edges = await resolver.resolve(context);
    const ids = edges.map((edge) => edge.id);

    expect(
      findEdge(
        ids,
        'file:src/Module/MobileApi/Controllers/MobileListingController.php→file:src/Module/Listing/Requests/StoreListingRequest.php:uses_contract_family'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/MobileApi/Controllers/MobileListingController.php→file:src/Module/Listing/Requests/StoreListingRequest.php:validates_contract_family'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/MobileApi/Controllers/MobileListingController.php→file:src/Module/Listing/Resources/ListingResource.php:emits_resource_family'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/MobileApi/Resources/MobileListingResource.php→file:src/Module/Listing/Models/Listing.php:transforms_model'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Module/ListingImport/Services/RunImport.php→file:src/Module/Listing/Models/Listing.php:imports_pipeline_artifact'
      )
    ).toBe(true);
  });

  it('persists glue-origin controller evidence when shared glue points into a module', async () => {
    const context = makeContext([
      {
        filePath: 'src/Module/Listing/Requests/StoreListingRequest.php',
        content: `<?php
namespace App\\Module\\Listing\\Requests;
class StoreListingRequest {}
`,
      },
      {
        filePath: 'src/Module/Listing/Services/ListingCommandService.php',
        content: `<?php
namespace App\\Module\\Listing\\Services;
class ListingCommandService {}
`,
      },
      {
        filePath: 'src/Http/Controllers/Api/ListingController.php',
        content: `<?php
namespace App\\Http\\Controllers\\Api;

use App\\Module\\Listing\\Requests\\StoreListingRequest;
use App\\Module\\Listing\\Services\\ListingCommandService;

class ListingController
{
    public function __construct(private ListingCommandService $service) {}

    public function store(StoreListingRequest $request): array
    {
        return [];
    }
}
`,
      },
    ]);

    const edges = await resolver.resolve(context);
    const ids = edges.map((edge) => edge.id);

    expect(
      findEdge(
        ids,
        'file:src/Http/Controllers/Api/ListingController.php→file:src/Module/Listing/Services/ListingCommandService.php:resolves_service'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Http/Controllers/Api/ListingController.php→file:src/Module/Listing/Requests/StoreListingRequest.php:uses_contract_family'
      )
    ).toBe(true);
    expect(
      findEdge(
        ids,
        'file:src/Http/Controllers/Api/ListingController.php→file:src/Module/Listing/Requests/StoreListingRequest.php:validates_contract_family'
      )
    ).toBe(true);
  });
});
