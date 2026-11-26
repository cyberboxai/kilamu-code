from fastapi import APIRouter, HTTPException

from app.services.customer_service import CustomerNotFound, CustomerService

router = APIRouter(prefix="/customers")


@router.get("/{customer_id}")
def read_customer(customer_id: int, service: CustomerService):
    try:
        return service.get_customer(customer_id)
    except CustomerNotFound:
        raise HTTPException(status_code=404)
