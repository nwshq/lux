<?php

namespace App\Livewire\Admin;

use Livewire\Component;

final class UserTable extends Component
{
    public function render()
    {
        return view('livewire.admin.user-table')->layout('layouts.app');
    }
}
