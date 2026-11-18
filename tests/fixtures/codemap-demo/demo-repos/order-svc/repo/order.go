package repo

import (
	"context"

	"gorm.io/gorm"

	"shop/order-svc/service"
)

type Repo struct {
	db *gorm.DB
}

func (r *Repo) Save(ctx context.Context, o *service.Order) error {
	return r.db.WithContext(ctx).Create(o).Error // INSERT INTO orders ...
}

func (r *Repo) UpdateStatus(ctx context.Context, id int64, from, to int8) (int64, error) {
	res := r.db.WithContext(ctx).Model(&service.Order{}).
		Where("id = ? AND status = ?", id, from).
		Update("status", to)
	return res.RowsAffected, res.Error
}
