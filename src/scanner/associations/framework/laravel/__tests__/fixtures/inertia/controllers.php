<?php
namespace App\Http\Controllers;

use Inertia\Inertia;
use function inertia as inert;

class PageController
{
    public function facade() { return Inertia::render('Users/Index', []); }
    public function helper() { return inertia('Reports/Show'); }
    public function namespacePage() { return Inertia::render('@contact::Web/ContactIndex'); }
    public function legacy() { return inertia('@AcmeCore::Shared/Dashboard'); }
    public function dynamic($page) { return Inertia::render($page); }
    public function concatenated() { return inertia('Users/' . 'Index'); }
    public function interpolated($id) { return inertia("Users/$id"); }
    public function conditional($admin) { return inertia($admin ? 'Admin' : 'User'); }
    public function aliased() { return inert('Users/Index'); }
}

function landing() { return inertia('Landing'); }
