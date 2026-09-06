<?php
namespace App\Nova;
use Laravel\Nova\Resource;
use App\Models\Contact as ContactModel;
class Contact extends Resource { public static $model = ContactModel::class; }
