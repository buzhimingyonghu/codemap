package service

import (
	"context"
	"time"
)

// StartReleaser runs in its own goroutine: it releases stock locks of orders that were not paid.
func (s *Service) StartReleaser(ctx context.Context) {
	go s.releaseLoop(ctx)
}

func (s *Service) releaseLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	paid := s.events.Subscribe("order-paid")
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-paid:
			s.locks.Forget(id)
		case <-ticker.C:
			for _, lock := range s.locks.Expired() {
				if lock.Paid {
					s.locks.Forget(lock.OrderID)
				} else {
					s.invCli.ReleaseStock(ctx, lock.ID)
				}
			}
		}
	}
}
